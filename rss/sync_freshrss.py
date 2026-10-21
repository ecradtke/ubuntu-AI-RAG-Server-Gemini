#!/usr/bin/env python3
"""Sync FreshRSS -> PostgreSQL -> OpenVINO Embeddings (NPU) -> Qdrant.

Automatically detects PostgreSQL tables across all schemas, detects if Qdrant
is empty or missing, auto-creates public.articles if needed, resets vector_indexed flags,
and rebuilds vector points with full progress logging.
"""
import os
import sys
import time
import re
import uuid
import logging
import requests

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    psycopg2 = None

try:
    from qdrant_client import QdrantClient
    from qdrant_client.models import Distance, VectorParams, PointStruct, PayloadSchemaType
except ImportError:
    QdrantClient = None

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] k13-rss-sync: %(message)s")
logger = logging.getLogger("rss-sync")

# Environment variables
FRESHRSS_BASE_URL = os.getenv("FRESHRSS_BASE_URL", "").rstrip("/")
FRESHRSS_USER = os.getenv("FRESHRSS_USER", "")
FRESHRSS_API_PASS = os.getenv("FRESHRSS_API_PASS", "")

PG_HOST = os.getenv("PG_HOST") or os.getenv("NAS_HOST", "127.0.0.1")
PG_PORT = int(os.getenv("PG_PORT", "5432"))
PG_DB = os.getenv("PG_DB", "fetch42")
PG_USER = os.getenv("PG_USER", "postgres")
PG_PASS = os.getenv("PG_PASS", "")

EMBEDDING_HOST = os.getenv("EMBEDDING_HOST") or os.getenv("OPENVINO_URL", "http://127.0.0.1:11434").rstrip("/")
EMBED_MODEL = os.getenv("EMBED_MODEL", "BAAI/bge-base-en-v1.5")
EMBED_DIMS = 384 if "small" in EMBED_MODEL else 768

QDRANT_HOST = os.getenv("QDRANT_HOST", "127.0.0.1")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
QDRANT_COLLECTION = os.getenv("QDRANT_COLLECTION", "rss_articles")


def get_pg_connection(dbname=None):
    if not psycopg2:
        logger.warning("psycopg2 is not installed in the Python environment.")
        return None
    db = dbname or PG_DB
    try:
        conn = psycopg2.connect(
            host=PG_HOST, port=PG_PORT, dbname=db, user=PG_USER, password=PG_PASS, connect_timeout=10
        )
        return conn
    except Exception as e:
        logger.warning(f"PostgreSQL connection to {PG_HOST}:{PG_PORT}/{db} failed: {e}")
        return None


def detect_and_prep_pg_table(conn, dbname):
    """Detects existing article/entry tables in PostgreSQL or auto-creates public.articles."""
    with conn.cursor() as cur:
        # Check all non-system tables
        cur.execute("""
            SELECT table_schema, table_name 
            FROM information_schema.tables 
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY table_schema, table_name;
        """)
        all_tables = cur.fetchall()
        table_list = [f"{s}.{t}" for s, t in all_tables]
        logger.info(f"Available tables in database '{dbname}': {table_list}")

        target_schema = None
        target_table = None
        table_type = "articles"

        # 1. Search for custom article candidate names
        for cand in ("articles", "rss_articles", "rss_items", "feed_entries"):
            for s, t in all_tables:
                if t.lower() == cand:
                    target_schema = s
                    target_table = t
                    table_type = "articles"
                    break
            if target_table:
                break

        # 2. Search for FreshRSS native entry tables (_entry, <user>_entry, freshrss_entry, entry)
        if not target_table:
            for s, t in all_tables:
                t_lower = t.lower()
                if t_lower == "entry" or t_lower.endswith("_entry") or t_lower == "_entry":
                    target_schema = s
                    target_table = t
                    table_type = "freshrss"
                    break

        # 3. Search for any table containing content/title columns
        if not target_table and all_tables:
            cur.execute("""
                SELECT table_schema, table_name 
                FROM information_schema.columns 
                WHERE column_name IN ('content', 'title', 'link', 'url')
                AND table_schema NOT IN ('pg_catalog', 'information_schema')
                GROUP BY table_schema, table_name
                HAVING count(*) >= 2;
            """)
            matched = cur.fetchall()
            if matched:
                target_schema, target_table = matched[0]
                table_type = "articles"

        # 4. Fallback: Auto-create public.articles if no suitable table exists
        if not target_table:
            target_schema = "public"
            target_table = "articles"
            table_type = "articles"
            logger.info("No existing article table found in PostgreSQL. Creating 'public.articles'...")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS public.articles (
                    id VARCHAR(512) PRIMARY KEY,
                    title TEXT,
                    url TEXT,
                    feed TEXT,
                    category TEXT,
                    published_at BIGINT,
                    content TEXT,
                    vector_indexed BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_articles_vector_indexed ON public.articles(vector_indexed);
                CREATE INDEX IF NOT EXISTS idx_articles_published_at ON public.articles(published_at);
            """)
            conn.commit()

        qualified = f'"{target_schema}"."{target_table}"'

        # Ensure vector_indexed column exists
        cur.execute(f"""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                               WHERE table_schema = '{target_schema}' 
                               AND table_name = '{target_table}' 
                               AND column_name = 'vector_indexed') THEN
                    ALTER TABLE {qualified} ADD COLUMN vector_indexed BOOLEAN DEFAULT FALSE;
                END IF;
            END $$;
        """)
        conn.commit()

        # Find companion feed and category tables if FreshRSS entry table
        feed_table = None
        category_table = None
        if table_type == "freshrss":
            for s, t in all_tables:
                t_lower = t.lower()
                if t_lower == "feed" or t_lower.endswith("_feed"):
                    feed_table = f'"{s}"."{t}"'
                elif t_lower == "category" or t_lower.endswith("_category"):
                    category_table = f'"{s}"."{t}"'

        return {
            "schema": target_schema,
            "table": target_table,
            "qualified": qualified,
            "type": table_type,
            "feed_table": feed_table,
            "category_table": category_table,
            "is_empty": len(all_tables) == 0
        }


def get_freshrss_auth():
    if not FRESHRSS_BASE_URL or not FRESHRSS_USER or not FRESHRSS_API_PASS:
        return None
    login_url = f"{FRESHRSS_BASE_URL}/accounts/ClientLogin"
    try:
        r = requests.post(
            login_url,
            data={"Email": FRESHRSS_USER, "Passwd": FRESHRSS_API_PASS},
            params={"output": "json"},
            timeout=10
        )
        if r.status_code == 200:
            for line in r.text.splitlines():
                if line.startswith("Auth="):
                    return line.split("Auth=", 1)[1].strip()
    except Exception as e:
        logger.warning(f"FreshRSS login failed: {e}")
    return None


def fetch_freshrss_items(auth_token, limit=500, max_pages=3):
    """Fetches reading list items via Google Reader API with pagination."""
    if not auth_token:
        return []
    url = f"{FRESHRSS_BASE_URL}/reader/api/0/stream/contents/reading-list"
    headers = {"Authorization": f"GoogleLogin auth={auth_token}"}
    items = []
    continuation = None

    for _ in range(max_pages):
        params = {"n": limit, "output": "json"}
        if continuation:
            params["c"] = continuation
        try:
            r = requests.get(url, headers=headers, params=params, timeout=25)
            if r.status_code != 200:
                break
            data = r.json()
            raw_items = data.get("items", [])
            for item in raw_items:
                item_id = str(item.get("id", ""))
                title = item.get("title", "Untitled")
                crawl_time = item.get("crawlTimeMsec", "")
                pub_time = int(crawl_time) // 1000 if crawl_time else int(time.time())
                url_val = item.get("canonical", [{}])[0].get("href") or item.get("alternate", [{}])[0].get("href", "")
                origin = item.get("origin", {})
                feed = origin.get("title") or "FreshRSS"
                categories = item.get("categories", [])
                group = categories[0].split("/")[-1] if categories else "General"
                summary = item.get("summary", {}).get("content", "") or item.get("content", {}).get("content", "")
                clean_text = re.sub(r"<[^>]+>", " ", summary).strip() or title

                items.append({
                    "id": item_id,
                    "title": title,
                    "url": url_val,
                    "feed": feed,
                    "group": group,
                    "published_at": pub_time,
                    "text": clean_text
                })

            continuation = data.get("continuation")
            if not continuation or len(raw_items) < limit:
                break
        except Exception as e:
            logger.warning(f"Error fetching FreshRSS items: {e}")
            break

    return items


def get_embedding(text):
    for endpoint, payload in [
        ("/api/embed", {"model": EMBED_MODEL, "input": text[:2000]}),
        ("/api/embeddings", {"model": EMBED_MODEL, "prompt": text[:2000]})
    ]:
        try:
            r = requests.post(f"{EMBEDDING_HOST}{endpoint}", json=payload, timeout=60)
            if r.status_code == 200:
                data = r.json()
                if "embeddings" in data and data["embeddings"]:
                    return data["embeddings"][0]
                if "embedding" in data:
                    return data["embedding"]
        except Exception:
            continue
    return None


def main():
    logger.info("Starting FreshRSS -> Postgres -> Qdrant sync run...")
    if not QdrantClient:
        logger.error("qdrant_client is not installed in the python environment.")
        sys.exit(1)

    qdrant = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT, timeout=30.0)

    # 1. Connect to PostgreSQL
    conn = get_pg_connection(PG_DB)
    active_db = PG_DB
    table_info = None

    if conn:
        table_info = detect_and_prep_pg_table(conn, active_db)
        # If active_db was completely empty, check if database 'freshrss' exists and has tables
        if table_info["is_empty"] and active_db != "freshrss":
            alt_conn = get_pg_connection("freshrss")
            if alt_conn:
                alt_info = detect_and_prep_pg_table(alt_conn, "freshrss")
                if not alt_info["is_empty"]:
                    logger.info("Found populated article tables in database 'freshrss'. Switching to 'freshrss'.")
                    conn.close()
                    conn = alt_conn
                    active_db = "freshrss"
                    table_info = alt_info
                else:
                    alt_conn.close()

        logger.info(f"Connected to PostgreSQL database '{active_db}', using table {table_info['qualified']}.")

    # 2. Check Qdrant collection status & determine if rebuild is needed
    rebuild_needed = False
    try:
        cols_resp = qdrant.get_collections()
        col_names = [c.name for c in cols_resp.collections]

        if QDRANT_COLLECTION not in col_names:
            logger.info(f"Collection '{QDRANT_COLLECTION}' does not exist in Qdrant. Rebuilding...")
            rebuild_needed = True
        else:
            col_info = qdrant.get_collection(QDRANT_COLLECTION)
            cur_dim = col_info.config.params.vectors.size
            cur_count = col_info.points_count or 0

            if cur_dim != EMBED_DIMS:
                logger.warning(
                    f"Vector dimension mismatch in '{QDRANT_COLLECTION}': expected {EMBED_DIMS}, got {cur_dim}. Recreating collection."
                )
                qdrant.delete_collection(QDRANT_COLLECTION)
                rebuild_needed = True
            elif cur_count == 0:
                logger.info(f"Collection '{QDRANT_COLLECTION}' exists but is empty (0 points). Rebuild needed.")
                rebuild_needed = True
            else:
                logger.info(f"Qdrant collection '{QDRANT_COLLECTION}' is healthy with {cur_count:,} points.")

        if rebuild_needed:
            logger.info(f"Creating collection '{QDRANT_COLLECTION}' ({EMBED_DIMS} dims, Cosine)...")
            qdrant.create_collection(
                collection_name=QDRANT_COLLECTION,
                vectors_config=VectorParams(size=EMBED_DIMS, distance=Distance.COSINE)
            )
            # Create payload indexes for fast filtered retrieval
            qdrant.create_payload_index(QDRANT_COLLECTION, "published_at", PayloadSchemaType.INTEGER)
            qdrant.create_payload_index(QDRANT_COLLECTION, "feed", PayloadSchemaType.KEYWORD)
            qdrant.create_payload_index(QDRANT_COLLECTION, "group", PayloadSchemaType.KEYWORD)
            qdrant.create_payload_index(QDRANT_COLLECTION, "url", PayloadSchemaType.KEYWORD)

            # Reset vector_indexed = FALSE in PostgreSQL so all items are re-embedded
            if conn and table_info:
                with conn.cursor() as cur:
                    logger.info(
                        f"Resetting vector_indexed=FALSE on PostgreSQL table {table_info['qualified']} to trigger full re-embedding..."
                    )
                    cur.execute(f"UPDATE {table_info['qualified']} SET vector_indexed = FALSE;")
                    conn.commit()

    except Exception as e:
        logger.error(f"Error checking Qdrant status: {e}")
        sys.exit(1)

    # 3. Pull newest articles from FreshRSS API into Postgres
    auth = get_freshrss_auth()
    new_items = []
    if auth:
        fetch_limit = 500 if rebuild_needed else 150
        max_p = 5 if rebuild_needed else 2
        new_items = fetch_freshrss_items(auth, limit=fetch_limit, max_pages=max_p)
        logger.info(f"Fetched {len(new_items)} articles from FreshRSS API.")

        if new_items and conn and table_info and table_info["type"] == "articles":
            with conn.cursor() as cur:
                inserted_count = 0
                for it in new_items:
                    try:
                        cur.execute(f"""
                            INSERT INTO {table_info['qualified']} (id, title, url, feed, category, published_at, content, vector_indexed)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, FALSE)
                            ON CONFLICT (id) DO UPDATE SET
                                title = EXCLUDED.title,
                                url = EXCLUDED.url,
                                feed = EXCLUDED.feed,
                                category = EXCLUDED.category,
                                published_at = EXCLUDED.published_at,
                                content = EXCLUDED.content
                            RETURNING id;
                        """, (it["id"], it["title"], it["url"], it["feed"], it["group"], it["published_at"], it["text"]))
                        if cur.fetchone():
                            inserted_count += 1
                    except Exception as ins_err:
                        logger.warning(f"Insert error: {ins_err}")
                        conn.rollback()
                        break
                conn.commit()
                if inserted_count > 0:
                    logger.info(f"Inserted / refreshed {inserted_count} articles from FreshRSS into PostgreSQL table {table_info['qualified']}.")

    # 4. Fetch unindexed records from PostgreSQL and embed into Qdrant
    if conn and table_info:
        qualified = table_info["qualified"]
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(f"SELECT COUNT(*) FROM {qualified} WHERE vector_indexed IS FALSE OR vector_indexed IS NULL;")
            total_unindexed = cur.fetchone()[0]
            logger.info(f"Found {total_unindexed:,} articles in PostgreSQL requiring vector embedding.")

            if total_unindexed > 0:
                batch_size = 50
                processed = 0

                while True:
                    if table_info["type"] == "freshrss" and table_info["feed_table"]:
                        cur.execute(f"""
                            SELECT e.id, e.title, COALESCE(e.link, '') as url,
                                   COALESCE(f.name, 'FreshRSS') as feed,
                                   COALESCE(c.name, 'General') as category,
                                   EXTRACT(EPOCH FROM COALESCE(e.date, CURRENT_TIMESTAMP))::bigint as published_at,
                                   COALESCE(e.content, '') as content
                            FROM {qualified} e
                            LEFT JOIN {table_info['feed_table']} f ON e.id_feed = f.id
                            LEFT JOIN {table_info['category_table'] or "f"} c ON f.category = c.id
                            WHERE e.vector_indexed IS FALSE OR e.vector_indexed IS NULL
                            LIMIT {batch_size};
                        """)
                    else:
                        cur.execute(f"""
                            SELECT id, title, url, feed, category, published_at, content
                            FROM {qualified} 
                            WHERE vector_indexed IS FALSE OR vector_indexed IS NULL 
                            LIMIT {batch_size};
                        """)

                    rows = cur.fetchall()
                    if not rows:
                        break

                    points_to_upsert = []
                    processed_ids = []

                    for row in rows:
                        title = row.get("title") or "Untitled"
                        text = row.get("content") or row.get("text") or row.get("summary") or title
                        clean_text = re.sub(r"<[^>]+>", " ", text).strip()
                        url_val = row.get("url") or row.get("link") or ""
                        feed_val = row.get("feed") or row.get("source") or "News"
                        group_val = row.get("category") or row.get("group") or "General"
                        pub_time = row.get("published_at") or int(time.time())

                        # Generate vector embedding on NPU
                        vec = get_embedding(f"{title}\n{clean_text}")
                        if vec and len(vec) == EMBED_DIMS:
                            row_id = str(row.get("id") or url_val)
                            pt_id = str(uuid.uuid5(uuid.NAMESPACE_URL, row_id))
                            payload = {
                                "title": title,
                                "url": url_val,
                                "feed": feed_val,
                                "group": group_val,
                                "published_at": int(pub_time),
                                "text": clean_text
                            }
                            points_to_upsert.append(PointStruct(id=pt_id, vector=vec, payload=payload))
                            processed_ids.append(row["id"])

                    if points_to_upsert:
                        qdrant.upsert(collection_name=QDRANT_COLLECTION, points=points_to_upsert)

                        # Mark batch as indexed in PostgreSQL
                        with conn.cursor() as update_cur:
                            update_cur.execute(f"""
                                UPDATE {qualified} SET vector_indexed = TRUE 
                                WHERE id = ANY(%s);
                            """, (processed_ids,))
                            conn.commit()

                        processed += len(points_to_upsert)
                        logger.info(f"Rebuilding database: {processed:,} / {total_unindexed:,} articles indexed into Qdrant...")

        conn.close()

    # 5. Direct embed fallback if PostgreSQL was not configured or empty, but FreshRSS items exist
    col_now = qdrant.get_collection(QDRANT_COLLECTION)
    if (col_now.points_count or 0) == 0 and new_items:
        logger.info(f"Embedding {len(new_items)} FreshRSS items directly into Qdrant...")
        points = []
        for it in new_items:
            vec = get_embedding(f"{it['title']}\n{it['text']}")
            if vec and len(vec) == EMBED_DIMS:
                pt_id = str(uuid.uuid5(uuid.NAMESPACE_URL, it["id"] or it["url"]))
                points.append(PointStruct(id=pt_id, vector=vec, payload={
                    "title": it["title"],
                    "url": it["url"],
                    "feed": it["feed"],
                    "group": it["group"],
                    "published_at": it["published_at"],
                    "text": it["text"]
                }))
        if points:
            qdrant.upsert(collection_name=QDRANT_COLLECTION, points=points)

    final_count = qdrant.get_collection(QDRANT_COLLECTION).points_count or 0
    logger.info(f"Sync run finished successfully. Current Qdrant point count: {final_count:,}.")


if __name__ == "__main__":
    main()
