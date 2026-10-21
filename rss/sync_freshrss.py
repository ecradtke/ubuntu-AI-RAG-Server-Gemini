#!/usr/bin/env python3
"""Sync FreshRSS -> PostgreSQL -> OpenVINO Embeddings (NPU) -> Qdrant.

Automatically detects if the Qdrant vector database is empty or missing,
or if the embedding dimension changed, and rebuilds the collection from PostgreSQL.
"""
import os
import sys
import time
import re
import uuid
import logging
from datetime import datetime, timezone
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

# Environment settings
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


def get_pg_connection():
    if not psycopg2:
        logger.error("psycopg2 is not installed in the python environment.")
        return None
    try:
        conn = psycopg2.connect(
            host=PG_HOST, port=PG_PORT, dbname=PG_DB, user=PG_USER, password=PG_PASS, connect_timeout=10
        )
        return conn
    except Exception as e:
        logger.warning(f"PostgreSQL connection to {PG_HOST}:{PG_PORT}/{PG_DB} failed: {e}")
        return None


def detect_and_prep_pg_table(conn):
    """Finds the articles table in PostgreSQL and ensures vector_indexed column exists."""
    with conn.cursor() as cur:
        # Check table candidates
        cur.execute("""
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name IN ('articles', 'rss_items', 'entry', 'freshrss_entry', 'feed_entries');
        """)
        found = [r[0] for r in cur.fetchall()]
        
        target_table = None
        for candidate in ('articles', 'rss_items', 'entry', 'freshrss_entry', 'feed_entries'):
            if candidate in found:
                target_table = candidate
                break

        if not target_table:
            # Fallback: create articles table if no table exists
            target_table = 'articles'
            cur.execute("""
                CREATE TABLE IF NOT EXISTS articles (
                    id VARCHAR(255) PRIMARY KEY,
                    title TEXT,
                    url TEXT,
                    feed TEXT,
                    category TEXT,
                    published_at BIGINT,
                    content TEXT,
                    vector_indexed BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
            """)
            conn.commit()

        # Ensure vector_indexed column exists
        cur.execute(f"""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                               WHERE table_name = '{target_table}' AND column_name = 'vector_indexed') THEN
                    ALTER TABLE {target_table} ADD COLUMN vector_indexed BOOLEAN DEFAULT FALSE;
                END IF;
            END $$;
        """)
        conn.commit()
        return target_table


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


def fetch_freshrss_items(auth_token, limit=150):
    if not auth_token:
        return []
    url = f"{FRESHRSS_BASE_URL}/reader/api/0/stream/contents/reading-list"
    headers = {"Authorization": f"GoogleLogin auth={auth_token}"}
    params = {"n": limit, "output": "json"}
    try:
        r = requests.get(url, headers=headers, params=params, timeout=25)
        if r.status_code == 200:
            data = r.json()
            items = []
            for item in data.get("items", []):
                item_id = item.get("id", "")
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
            return items
    except Exception as e:
        logger.warning(f"Error fetching FreshRSS items: {e}")
    return []


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
    conn = get_pg_connection()
    table_name = None
    if conn:
        table_name = detect_and_prep_pg_table(conn)
        logger.info(f"Connected to PostgreSQL database '{PG_DB}', using table '{table_name}'.")

    # 2. Check Qdrant collection status & determine if rebuild is needed
    rebuild_needed = False
    try:
        cols_resp = qdrant.get_collections()
        col_names = [c.name for c in cols_resp.collections]
        
        if QDRANT_COLLECTION not in col_names:
            logger.info(f"Collection '{QDRANT_COLLECTION}' does not exist in Qdrant. Rebuild needed.")
            rebuild_needed = True
        else:
            col_info = qdrant.get_collection(QDRANT_COLLECTION)
            cur_dim = col_info.config.params.vectors.size
            cur_count = col_info.points_count or 0
            
            if cur_dim != EMBED_DIMS:
                logger.warning(f"Vector dimension mismatch in '{QDRANT_COLLECTION}': expected {EMBED_DIMS}, got {cur_dim}. Recreating collection.")
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
            # Create indexing schemas
            qdrant.create_payload_index(QDRANT_COLLECTION, "published_at", PayloadSchemaType.INTEGER)
            qdrant.create_payload_index(QDRANT_COLLECTION, "feed", PayloadSchemaType.KEYWORD)
            qdrant.create_payload_index(QDRANT_COLLECTION, "group", PayloadSchemaType.KEYWORD)
            qdrant.create_payload_index(QDRANT_COLLECTION, "url", PayloadSchemaType.KEYWORD)

            # Reset vector_indexed = FALSE in PostgreSQL so all items are re-embedded
            if conn and table_name:
                with conn.cursor() as cur:
                    logger.info(f"Resetting vector_indexed=FALSE on PostgreSQL table '{table_name}' to trigger full re-embedding...")
                    cur.execute(f"UPDATE {table_name} SET vector_indexed = FALSE;")
                    conn.commit()

    except Exception as e:
        logger.error(f"Error checking Qdrant status: {e}")
        sys.exit(1)

    # 3. Pull newest articles from FreshRSS into Postgres
    auth = get_freshrss_auth()
    if auth:
        new_items = fetch_freshrss_items(auth)
        if new_items and conn and table_name:
            with conn.cursor() as cur:
                inserted_count = 0
                for it in new_items:
                    # Generic upsert
                    cur.execute(f"""
                        INSERT INTO {table_name} (id, title, url, feed, category, published_at, content, vector_indexed)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, FALSE)
                        ON CONFLICT (id) DO NOTHING
                        RETURNING id;
                    """, (it["id"], it["title"], it["url"], it["feed"], it["group"], it["published_at"], it["text"]))
                    if cur.fetchone():
                        inserted_count += 1
                conn.commit()
                if inserted_count > 0:
                    logger.info(f"Inserted {inserted_count} new articles from FreshRSS into PostgreSQL.")

    # 4. Fetch all unindexed records from PostgreSQL in batches and embed into Qdrant
    if conn and table_name:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(f"SELECT COUNT(*) FROM {table_name} WHERE vector_indexed IS FALSE OR vector_indexed IS NULL;")
            total_unindexed = cur.fetchone()[0]
            logger.info(f"Found {total_unindexed:,} articles in PostgreSQL requiring vector embedding.")

            if total_unindexed > 0:
                batch_size = 50
                processed = 0

                while True:
                    cur.execute(f"""
                        SELECT * FROM {table_name} 
                        WHERE vector_indexed IS FALSE OR vector_indexed IS NULL 
                        ORDER BY published_at DESC 
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
                                UPDATE {table_name} SET vector_indexed = TRUE 
                                WHERE id = ANY(%s);
                            """, (processed_ids,))
                            conn.commit()

                        processed += len(points_to_upsert)
                        logger.info(f"Rebuilding database: {processed:,} / {total_unindexed:,} articles indexed into Qdrant...")

        conn.close()

    logger.info(f"Sync run finished. Current Qdrant point count: {qdrant.get_collection(QDRANT_COLLECTION).points_count:,}.")


if __name__ == "__main__":
    main()
