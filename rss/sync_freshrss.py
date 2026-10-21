#!/usr/bin/env python3
"""Sync FreshRSS -> PostgreSQL -> OpenVINO Embeddings (NPU) -> Qdrant.

Automatically detects PostgreSQL tables across all schemas, dynamically adapts
to whatever columns exist in the articles table (title, url/link, feed/source,
category/group, published_at/date, content/summary), detects if Qdrant is empty
or missing, auto-creates public.articles if needed, resets vector_indexed,
and continuously embeds unindexed articles via OpenVINO into Qdrant.
"""

import os
import sys
import time
import uuid
import re
import logging
from typing import List, Dict, Any, Optional

import requests
import psycopg2
import psycopg2.extras
from qdrant_client import QdrantClient
from qdrant_client.http.models import Distance, VectorParams, PointStruct, PayloadSchemaType

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] k13-rss-sync: %(message)s"
)
logger = logging.getLogger("k13-rss-sync")

# Environment & Config
QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
QDRANT_COLLECTION = os.environ.get("QDRANT_COLLECTION", "rss_articles")

EMBEDDING_HOST = os.environ.get("EMBEDDING_HOST", "http://127.0.0.1:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-base-en-v1.5")
EMBED_DIMS = int(os.environ.get("EMBED_DIMS", "768"))
if "small" in EMBED_MODEL:
    EMBED_DIMS = 384

# Fallback: directly parse .env if present so python sees variables even without wrapper
def _load_env_file():
    candidates = [
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"),
        "/opt/fetch42/.env",
        ".env"
    ]
    for path in candidates:
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        if "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip().strip("'\"").rstrip("\r")
                            if k and (k not in os.environ or not os.environ[k]):
                                os.environ[k] = v
            except Exception as e:
                logger.debug(f"Could not parse {path}: {e}")
            break

_load_env_file()

def get_env_opt(*keys: str, default: str = "") -> str:
    for k in keys:
        v = (os.environ.get(k) or "").strip()
        if v:
            return v
    return default

PG_HOST = get_env_opt("PG_HOST", "POSTGRES_HOST", "NAS_HOST", "NAS_IP", "DB_HOST", default="127.0.0.1")
PG_PORT = int(get_env_opt("PG_PORT", "POSTGRES_PORT", default="5432"))
PG_USER = get_env_opt("PG_USER", "POSTGRES_USER", "DB_USER", default="freshrss")
PG_PASSWORD = get_env_opt(
    "PG_PASS", "PG_PASSWORD", "PGPASSWORD",
    "POSTGRES_PASSWORD", "POSTGRES_PASS",
    "DB_PASS", "DB_PASSWORD", "FRESHRSS_DB_PASS",
    default=""
)
PG_DBNAME = get_env_opt("PG_DB", "PG_DBNAME", "POSTGRES_DB", default="fetch42")

FRESHRSS_BASE_URL = get_env_opt("FRESHRSS_BASE_URL", "FRESHRSS_URL", default="").rstrip("/")
if not FRESHRSS_BASE_URL and PG_HOST != "127.0.0.1":
    FRESHRSS_BASE_URL = f"http://{PG_HOST}:8080"
FRESHRSS_USER = get_env_opt("FRESHRSS_USER", default="")
FRESHRSS_API_PASS = get_env_opt("FRESHRSS_API_PASS", "FRESHRSS_PASSWORD", default="")


def connect_postgres(db: str):
    """Attempts PostgreSQL connection with fallback credentials."""
    pwd_display = f"YES ({len(PG_PASSWORD)} chars)" if PG_PASSWORD else "NO (EMPTY!)"
    logger.info(f"Connecting to PostgreSQL at {PG_HOST}:{PG_PORT}/{db} as user '{PG_USER}', password={pwd_display}...")
    try:
        conn = psycopg2.connect(
            host=PG_HOST,
            port=PG_PORT,
            user=PG_USER,
            password=PG_PASSWORD or None,
            dbname=db,
            connect_timeout=10
        )
        conn.autocommit = False
        return conn
    except Exception as e:
        logger.warning(f"PostgreSQL connection to {PG_HOST}:{PG_PORT}/{db} failed: {e}")
        return None


def detect_and_prep_pg_table(conn, dbname: str) -> Optional[Dict[str, Any]]:
    """Detects existing article/entry tables in PostgreSQL, inspects columns dynamically,
    and ensures vector_indexed column and index exist.
    """
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
        for cand in ("rss_articles", "articles", "rss_items", "feed_entries"):
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

        # Add index on vector_indexed if not exists for fast batch filtering
        safe_idx_name = f"idx_vec_{target_table[:20]}"
        try:
            cur.execute(f"CREATE INDEX IF NOT EXISTS {safe_idx_name} ON {qualified} (vector_indexed);")
            conn.commit()
        except Exception:
            conn.rollback()

        # Dynamic column inspection to construct tailored queries
        cur.execute("""
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_schema = %s AND table_name = %s;
        """, (target_schema, target_table))
        raw_cols = cur.fetchall()
        col_types = {row[0].lower(): row[1].lower() for row in raw_cols}
        cols = set(col_types.keys())
        logger.info(f"Inspected columns for {qualified}: {sorted(cols)}")

        # 1. Determine ID column
        id_candidates = ("id", "guid", "article_id", "entry_id", "link", "url")
        id_col = next((c for c in id_candidates if c in cols), sorted(cols)[0])
        id_is_int = any(k in col_types.get(id_col, "") for k in ("int", "serial"))

        # 2. Determine Title expression
        title_candidates = ("title", "headline", "subject", "name")
        title_col = next((c for c in title_candidates if c in cols), None)
        title_expr = f'COALESCE("{title_col}", \'Untitled\')' if title_col else "'Untitled'"

        # 3. Determine URL expression
        url_candidates = ("url", "link", "canonical", "permalink", "guid")
        url_col = next((c for c in url_candidates if c in cols), None)
        url_expr = f'COALESCE("{url_col}", \'\')' if url_col else "''"

        # 4. Determine Feed expression
        feed_candidates = ("feed", "feed_name", "feed_title", "source", "source_name", "channel", "site_name", "author", "id_feed", "feed_id")
        feed_col = next((c for c in feed_candidates if c in cols), None)
        if feed_col:
            feed_expr = f'COALESCE("{feed_col}"::text, \'FreshRSS\')'
        else:
            feed_expr = "'FreshRSS'"

        # 5. Determine Category expression
        cat_candidates = ("category", "category_name", "group", "tag", "tags", "categories", "topic", "section")
        cat_col = next((c for c in cat_candidates if c in cols), None)
        if cat_col:
            category_expr = f'COALESCE("{cat_col}"::text, \'General\')'
        else:
            category_expr = "'General'"

        # 6. Determine Published timestamp expression (normalize to Unix Epoch seconds)
        pub_candidates = ("published_at", "pub_date", "pubdate", "date", "published", "created_at", "timestamp", "crawl_time")
        pub_col = next((c for c in pub_candidates if c in cols), None)
        if pub_col:
            pub_dtype = col_types.get(pub_col, "")
            if "int" in pub_dtype:
                pub_expr = f'CASE WHEN "{pub_col}" > 100000000000 THEN ("{pub_col}" / 1000)::bigint ELSE COALESCE("{pub_col}"::bigint, EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::bigint) END'
            elif "timestamp" in pub_dtype or "date" in pub_dtype:
                pub_expr = f'EXTRACT(EPOCH FROM COALESCE("{pub_col}", CURRENT_TIMESTAMP))::bigint'
            else:
                pub_expr = f'EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::bigint'
        else:
            pub_expr = 'EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)::bigint'

        # 7. Determine Content expression
        content_candidates = ("content", "body", "text", "summary", "description", "raw_content", "details")
        content_col = next((c for c in content_candidates if c in cols), None)
        if content_col:
            content_expr = f'COALESCE("{content_col}", \'\')'
        else:
            content_expr = f'{title_expr}'

        # FreshRSS companion tables if relevant
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
            "id_col": id_col,
            "id_is_int": id_is_int,
            "title_expr": title_expr,
            "url_expr": url_expr,
            "feed_expr": feed_expr,
            "category_expr": category_expr,
            "pub_expr": pub_expr,
            "content_expr": content_expr,
            "feed_table": feed_table,
            "category_table": category_table,
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


def get_embedding(text: str) -> Optional[List[float]]:
    """Single-item embedding fallback."""
    for endpoint, payload in [
        ("/api/embed", {"model": EMBED_MODEL, "input": text[:2000]}),
        ("/api/embeddings", {"model": EMBED_MODEL, "prompt": text[:2000]})
    ]:
        try:
            r = requests.post(f"{EMBEDDING_HOST}{endpoint}", json=payload, timeout=60)
            if r.status_code == 200:
                data = r.json()
                if "embedding" in data and len(data["embedding"]) > 0:
                    return data["embedding"]
                elif "embeddings" in data and len(data["embeddings"]) > 0:
                    return data["embeddings"][0]
        except Exception:
            pass
    return None


def get_embeddings_batch(texts: List[str]) -> List[Optional[List[float]]]:
    """Generates embeddings for a batch of texts using OpenVINO server.
    Leverages batch endpoint if available, with robust single-item fallback.
    """
    if not texts:
        return []
    truncated = [t[:2000] for t in texts]

    # Try batch POST first
    for endpoint in ("/api/embed", "/api/embeddings"):
        try:
            r = requests.post(
                f"{EMBEDDING_HOST}{endpoint}",
                json={"model": EMBED_MODEL, "input": truncated},
                timeout=120
            )
            if r.status_code == 200:
                data = r.json()
                embs = data.get("embeddings")
                if embs and len(embs) == len(texts):
                    return embs
        except Exception:
            pass

    # Fallback to single requests
    return [get_embedding(t) for t in texts]


def ensure_qdrant_collection(qdrant: QdrantClient) -> bool:
    """Verifies Qdrant collection exists and matches EMBED_DIMS. Recreates if missing or mismatched.
    Returns True if the collection was newly created/recreated (indicating a full rebuild is required).
    """
    needs_rebuild = False
    try:
        collections = qdrant.get_collections().collections
        exists = any(c.name == QDRANT_COLLECTION for c in collections)
        if exists:
            info = qdrant.get_collection(QDRANT_COLLECTION)
            vector_size = 0
            if hasattr(info.config.params, "vectors"):
                v_param = info.config.params.vectors
                if hasattr(v_param, "size"):
                    vector_size = v_param.size
                elif isinstance(v_param, dict) and "" in v_param:
                    vector_size = v_param[""].size

            if vector_size != EMBED_DIMS:
                logger.warning(f"Collection '{QDRANT_COLLECTION}' dimension mismatch ({vector_size} != {EMBED_DIMS}). Recreating...")
                qdrant.delete_collection(QDRANT_COLLECTION)
                exists = False
                needs_rebuild = True
            elif (info.points_count or 0) == 0:
                logger.info(f"Collection '{QDRANT_COLLECTION}' exists but is empty (0 points). Marking for rebuild...")
                needs_rebuild = True
        else:
            logger.info(f"Collection '{QDRANT_COLLECTION}' does not exist in Qdrant. Rebuilding...")
            needs_rebuild = True

        if not exists:
            logger.info(f"Creating collection '{QDRANT_COLLECTION}' ({EMBED_DIMS} dims, Cosine)...")
            qdrant.create_collection(
                collection_name=QDRANT_COLLECTION,
                vectors_config=VectorParams(size=EMBED_DIMS, distance=Distance.COSINE),
            )
            for field in ("published_at", "feed", "group", "url"):
                schema_type = PayloadSchemaType.INTEGER if field == "published_at" else PayloadSchemaType.KEYWORD
                qdrant.create_payload_index(
                    collection_name=QDRANT_COLLECTION,
                    field_name=field,
                    field_schema=schema_type,
                    wait=True
                )
    except Exception as e:
        logger.error(f"Error checking Qdrant status: {e}")
        needs_rebuild = False

    return needs_rebuild


def main():
    logger.info("Starting FreshRSS -> Postgres -> Qdrant sync run...")

    # 1. Connect to Qdrant
    try:
        qdrant = QdrantClient(url=QDRANT_URL, timeout=15)
        # Test connection
        qdrant.get_collections()
    except Exception as e:
        logger.error(f"Could not connect to Qdrant at {QDRANT_URL}: {e}")
        sys.exit(1)

    # 2. Connect to PostgreSQL
    conn = None
    table_info = None
    for db in (PG_DBNAME, "freshrss", "postgres"):
        conn = connect_postgres(db)
        if conn:
            table_info = detect_and_prep_pg_table(conn, db)
            if table_info:
                logger.info(f"Connected to PostgreSQL database '{db}', using table {table_info['qualified']}.")
                break
            else:
                conn.close()
                conn = None

    # 3. Check Qdrant collection status; rebuild if missing or empty
    needs_rebuild = ensure_qdrant_collection(qdrant)

    if needs_rebuild and conn and table_info:
        qualified = table_info["qualified"]
        logger.info(f"Resetting vector_indexed=FALSE on PostgreSQL table {qualified} to trigger full re-embedding...")
        try:
            with conn.cursor() as cur:
                cur.execute(f"UPDATE {qualified} SET vector_indexed = FALSE;")
            conn.commit()
        except Exception as e:
            conn.rollback()
            logger.error(f"Failed to reset vector_indexed on {qualified}: {e}")

    # 4. Ingest new articles from FreshRSS API if credentials are provided
    auth_token = get_freshrss_auth()
    new_items = []
    if auth_token:
        logger.info("Fetching latest articles from FreshRSS API...")
        new_items = fetch_freshrss_items(auth_token, limit=200, max_pages=3)
        logger.info(f"Retrieved {len(new_items)} items from FreshRSS.")

        # Insert new items into PostgreSQL if available
        if conn and table_info and new_items:
            qualified = table_info["qualified"]
            id_col = table_info["id_col"]
            with conn.cursor() as cur:
                inserted_count = 0
                for it in new_items:
                    try:
                        cur.execute(f"""
                            INSERT INTO {qualified} ({id_col}, title, url, feed, category, published_at, content, vector_indexed)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, FALSE)
                            ON CONFLICT ({id_col}) DO NOTHING;
                        """, (
                            it["id"] or it["url"],
                            it["title"],
                            it["url"],
                            it["feed"],
                            it["group"],
                            it["published_at"],
                            it["text"]
                        ))
                        if cur.rowcount > 0:
                            inserted_count += 1
                    except Exception:
                        conn.rollback()
                        break
                conn.commit()
                if inserted_count > 0:
                    logger.info(f"Inserted {inserted_count} new articles from FreshRSS into {qualified}.")

    # 5. Fetch unindexed records from PostgreSQL and embed into Qdrant
    if conn and table_info:
        qualified = table_info["qualified"]
        id_col = table_info["id_col"]
        id_is_int = table_info["id_is_int"]

        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(f"SELECT COUNT(*) FROM {qualified} WHERE vector_indexed IS FALSE OR vector_indexed IS NULL;")
            total_unindexed = cur.fetchone()[0]
            logger.info(f"Found {total_unindexed:,} articles in PostgreSQL requiring vector embedding.")

            if total_unindexed > 0:
                batch_size = 50
                processed = 0

                # Build dynamic SELECT query based on inspected columns
                if table_info["type"] == "freshrss" and table_info["feed_table"]:
                    select_sql = f"""
                        SELECT e.{id_col} AS id,
                               e.title AS title,
                               COALESCE(e.link, '') AS url,
                               COALESCE(f.name, 'FreshRSS') AS feed,
                               COALESCE(c.name, 'General') AS category,
                               EXTRACT(EPOCH FROM COALESCE(e.date, CURRENT_TIMESTAMP))::bigint AS published_at,
                               COALESCE(e.content, '') AS content
                        FROM {qualified} e
                        LEFT JOIN {table_info['feed_table']} f ON e.id_feed = f.id
                        LEFT JOIN {table_info['category_table'] or "f"} c ON f.category = c.id
                        WHERE e.vector_indexed IS FALSE OR e.vector_indexed IS NULL
                        LIMIT {batch_size};
                    """
                else:
                    select_sql = f"""
                        SELECT "{id_col}" AS id,
                               {table_info['title_expr']} AS title,
                               {table_info['url_expr']} AS url,
                               {table_info['feed_expr']} AS feed,
                               {table_info['category_expr']} AS category,
                               {table_info['pub_expr']} AS published_at,
                               {table_info['content_expr']} AS content
                        FROM {qualified}
                        WHERE vector_indexed IS FALSE OR vector_indexed IS NULL
                        LIMIT {batch_size};
                    """

                while True:
                    cur.execute(select_sql)
                    rows = cur.fetchall()
                    if not rows:
                        break

                    texts_to_embed = []
                    row_metadata = []

                    for row in rows:
                        title = row.get("title") or "Untitled"
                        text = row.get("content") or title
                        clean_text = re.sub(r"<[^>]+>", " ", text).strip() or title
                        url_val = row.get("url") or ""
                        feed_val = row.get("feed") or "News"
                        group_val = row.get("category") or "General"
                        pub_time = row.get("published_at") or int(time.time())

                        embed_text = f"{title}\n{clean_text}"
                        texts_to_embed.append(embed_text)

                        row_metadata.append({
                            "raw_id": row["id"],
                            "title": title,
                            "url": url_val,
                            "feed": feed_val,
                            "group": group_val,
                            "published_at": int(pub_time),
                            "text": clean_text
                        })

                    # Batch embedding via OpenVINO server
                    vectors = get_embeddings_batch(texts_to_embed)

                    points_to_upsert = []
                    processed_ids = []

                    for meta, vec in zip(row_metadata, vectors):
                        if vec and len(vec) == EMBED_DIMS:
                            pt_id = str(uuid.uuid5(uuid.NAMESPACE_URL, str(meta["raw_id"] or meta["url"])))
                            payload = {
                                "title": meta["title"],
                                "url": meta["url"],
                                "feed": meta["feed"],
                                "group": meta["group"],
                                "published_at": meta["published_at"],
                                "text": meta["text"]
                            }
                            points_to_upsert.append(PointStruct(id=pt_id, vector=vec, payload=payload))
                            processed_ids.append(meta["raw_id"])

                    if points_to_upsert:
                        qdrant.upsert(collection_name=QDRANT_COLLECTION, points=points_to_upsert)

                        # Mark batch as indexed in PostgreSQL
                        if id_is_int:
                            clean_ids = [int(x) for x in processed_ids if str(x).isdigit()]
                        else:
                            clean_ids = [str(x) for x in processed_ids]

                        with conn.cursor() as update_cur:
                            update_cur.execute(f"""
                                UPDATE {qualified} SET vector_indexed = TRUE 
                                WHERE "{id_col}" = ANY(%s);
                            """, (clean_ids,))
                            conn.commit()

                        processed += len(points_to_upsert)
                        pct = (processed / total_unindexed) * 100
                        logger.info(f"Rebuilding database: {processed:,} / {total_unindexed:,} ({pct:.1f}%) articles indexed into Qdrant...")
                    else:
                        logger.warning("No vectors generated for current batch. Checking embedding service...")
                        time.sleep(2)

        conn.close()

    # 6. Direct embed fallback if PostgreSQL was not configured or empty, but FreshRSS items exist
    col_now = qdrant.get_collection(QDRANT_COLLECTION)
    if (col_now.points_count or 0) == 0 and new_items:
        logger.info(f"Embedding {len(new_items)} FreshRSS items directly into Qdrant...")
        texts = [f"{it['title']}\n{it['text']}" for it in new_items]
        vectors = get_embeddings_batch(texts)
        points = []
        for it, vec in zip(new_items, vectors):
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
