#!/usr/bin/env python3
"""Sync FreshRSS -> PostgreSQL -> OpenVINO Embeddings (Intel NPU) -> Qdrant.

Pipeline Workflow:
  1. Connects to the FreshRSS Server API (Google Reader compatible API).
  2. Queries all UNREAD messages using `xt=user/-/state/com.google/read`.
  3. Checks PostgreSQL table (e.g. public.rss_articles):
     - Unread items already in PostgreSQL with vector_indexed=TRUE are queued to be
       marked as READ in FreshRSS (clearing stale unread queue).
     - Genuinely new unread items are inserted into PostgreSQL with vector_indexed=FALSE
       using exact columns (id, feed_title, title, url, author, clean_content,
       "group", published_at, fetched_at, vector_indexed, freshrss_id).
  4. Generates dense vector embeddings via OpenVINO on Intel NPU (bge-base 768d)
     and upserts points into Qdrant collection 'rss_articles' matching payload format:
     { title, url, feed, group, published_at, text }.
  5. Updates PostgreSQL records to vector_indexed=TRUE.
  6. Calls the FreshRSS API (/reader/api/0/edit-tag with a=user/-/state/com.google/read)
     to mark all processed and already-indexed articles as READ in the FreshRSS server.
"""

import os
import sys
import time
import datetime
from datetime import timezone
import uuid
import re
import logging
from typing import List, Dict, Any, Optional, Tuple, Set

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


# Fallback: directly parse .env if present so python sees variables even without wrapper
def _load_env_file():
    candidates = [
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"),
        "/opt/fetch42/.env",
        "/opt/k13/.env",
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


# Qdrant configuration
qdrant_host = get_env_opt("QDRANT_HOST", default="127.0.0.1")
qdrant_port = get_env_opt("QDRANT_PORT", default="6333")
QDRANT_URL = get_env_opt("QDRANT_URL", default=f"http://{qdrant_host}:{qdrant_port}")
QDRANT_COLLECTION = get_env_opt("QDRANT_COLLECTION", default="rss_articles")

# OpenVINO Embeddings configuration (Intel NPU)
ov_port = get_env_opt("OV_PORT", default="11434")
EMBEDDING_HOST = get_env_opt("EMBEDDING_HOST", "OLLAMA_HOST", default=f"http://127.0.0.1:{ov_port}").rstrip("/")
EMBED_MODEL = get_env_opt("EMBED_MODEL", default="BAAI/bge-base-en-v1.5")
EMBED_DIMS = int(get_env_opt("EMBED_DIMS", default="768"))
if "small" in EMBED_MODEL:
    EMBED_DIMS = 384

# PostgreSQL configuration (NAS metadata store)
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

# FreshRSS Server API configuration (Google Reader compatible API)
FRESHRSS_BASE_URL = get_env_opt("FRESHRSS_BASE_URL", "FRESHRSS_URL", default="").rstrip("/")
if not FRESHRSS_BASE_URL and PG_HOST != "127.0.0.1":
    FRESHRSS_BASE_URL = f"http://{PG_HOST}:8080"
FRESHRSS_USER = get_env_opt("FRESHRSS_USER", default="")
FRESHRSS_API_PASS = get_env_opt("FRESHRSS_API_PASS", "FRESHRSS_PASSWORD", default="")


# ==============================================================================
# FreshRSS Google Reader API Implementation
# ==============================================================================

def normalize_greader_url_candidates(base_url: str) -> List[str]:
    """Generates candidate API base endpoints for FreshRSS Google Reader API."""
    clean = base_url.rstrip("/")
    if not clean:
        return []
    if clean.endswith("/api/greader.php") or clean.endswith("/greader.php"):
        return [clean]
    return [
        f"{clean}/api/greader.php",
        f"{clean}/p/api/greader.php",
        clean
    ]


def freshrss_login(base_url: str, user: str, password: str) -> Tuple[Optional[str], Optional[str]]:
    """Authenticates against FreshRSS Google Reader ClientLogin endpoint.
    Returns (working_api_base_url, auth_token).
    """
    if not base_url or not user or not password:
        logger.warning("FreshRSS credentials or URL missing. Skipping FreshRSS API sync.")
        return None, None

    candidates = normalize_greader_url_candidates(base_url)
    for api_base in candidates:
        login_url = f"{api_base}/accounts/ClientLogin"
        try:
            r = requests.post(
                login_url,
                data={"Email": user, "Passwd": password},
                params={"output": "json"},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=12
            )
            if r.status_code == 200:
                try:
                    j = r.json()
                    if "Auth" in j and j["Auth"]:
                        logger.info(f"[✓] FreshRSS authentication successful at {login_url}")
                        return api_base, str(j["Auth"]).strip()
                except Exception:
                    pass

                for line in r.text.splitlines():
                    if line.startswith("Auth="):
                        auth_token = line.split("Auth=", 1)[1].strip()
                        if auth_token:
                            logger.info(f"[✓] FreshRSS authentication successful at {login_url}")
                            return api_base, auth_token
        except Exception as e:
            logger.debug(f"Candidate {login_url} failed: {e}")

    logger.warning(f"Could not authenticate to FreshRSS at {base_url} (checked: {candidates})")
    return None, None


def get_freshrss_action_token(api_base: str, auth_token: str) -> Optional[str]:
    """Retrieves Google Reader CSRF action token 'T' required for edit-tag (mark as read)."""
    if not api_base or not auth_token:
        return None
    token_url = f"{api_base}/reader/api/0/token"
    try:
        r = requests.get(
            token_url,
            headers={"Authorization": f"GoogleLogin auth={auth_token}"},
            timeout=10
        )
        if r.status_code == 200:
            token = r.text.strip()
            if token:
                return token
    except Exception as e:
        logger.warning(f"Failed to fetch FreshRSS action token from {token_url}: {e}")
    return None


def fetch_unread_freshrss_articles(api_base: str, auth_token: str, limit: int = 150, max_pages: int = 20) -> List[Dict[str, Any]]:
    """Fetches ALL UNREAD items from FreshRSS using `xt=user/-/state/com.google/read`
    with pagination support.
    """
    if not api_base or not auth_token:
        return []

    url = f"{api_base}/reader/api/0/stream/contents/reading-list"
    headers = {"Authorization": f"GoogleLogin auth={auth_token}"}
    all_unread: List[Dict[str, Any]] = []
    continuation = None

    logger.info(f"Querying FreshRSS unread stream (xt=user/-/state/com.google/read) from {url}...")

    for page in range(1, max_pages + 1):
        params: Dict[str, Any] = {
            "output": "json",
            "n": limit,
            "xt": "user/-/state/com.google/read"  # EXCLUDE READ = UNREAD ONLY!
        }
        if continuation:
            params["c"] = continuation

        try:
            r = requests.get(url, headers=headers, params=params, timeout=30)
            if r.status_code != 200:
                logger.warning(f"FreshRSS stream request returned HTTP {r.status_code}: {r.text[:200]}")
                break

            data = r.json()
            raw_items = data.get("items", [])
            if not raw_items:
                break

            for item in raw_items:
                item_id = str(item.get("id", ""))
                title = (item.get("title") or "Untitled").strip()
                crawl_time = item.get("crawlTimeMsec", "")
                pub_time = int(crawl_time) // 1000 if crawl_time else int(time.time())

                # URL extraction
                url_val = ""
                canon = item.get("canonical")
                if canon and isinstance(canon, list) and canon[0].get("href"):
                    url_val = canon[0]["href"]
                elif item.get("alternate") and isinstance(item["alternate"], list) and item["alternate"][0].get("href"):
                    url_val = item["alternate"][0]["href"]
                elif item.get("href"):
                    url_val = item["href"]

                # Feed extraction
                origin = item.get("origin", {})
                feed = origin.get("title") or "FreshRSS"
                feed_stream_id = origin.get("streamId") or ""

                # Author extraction
                author = item.get("author") or origin.get("title") or ""

                # Category / group extraction
                categories = item.get("categories", [])
                group = "General"
                for cat in categories:
                    if "user/-/label/" in cat:
                        group = cat.split("user/-/label/")[-1].strip()
                        break
                    elif not cat.startswith("user/-/state/"):
                        group = cat.split("/")[-1].strip()

                # Content / summary
                summary = item.get("summary", {}).get("content", "") or item.get("content", {}).get("content", "")
                clean_text = re.sub(r"<[^>]+>", " ", summary)
                clean_text = re.sub(r"\s+", " ", clean_text).strip() or title

                all_unread.append({
                    "id": item_id,
                    "freshrss_id": item_id,
                    "title": title,
                    "url": url_val,
                    "feed": feed,
                    "author": author,
                    "feed_stream_id": feed_stream_id,
                    "group": group,
                    "published_at": pub_time,
                    "text": clean_text
                })

            continuation = data.get("continuation")
            if not continuation or len(raw_items) < limit:
                break

        except Exception as e:
            logger.warning(f"Error fetching FreshRSS page {page}: {e}")
            break

    logger.info(f"Retrieved {len(all_unread)} UNREAD articles from FreshRSS API.")
    return all_unread


def mark_freshrss_items_read(api_base: str, auth_token: str, csrf_token: str, item_ids: List[str]) -> int:
    """Marks the specified list of FreshRSS items as READ via the Google Reader /reader/api/0/edit-tag endpoint.
    Sends form data: a=user/-/state/com.google/read & T=csrf_token & i=item_id (in batches of 50).
    """
    if not api_base or not auth_token or not item_ids:
        return 0

    endpoint = f"{api_base}/reader/api/0/edit-tag"
    headers = {
        "Authorization": f"GoogleLogin auth={auth_token}",
        "Content-Type": "application/x-www-form-urlencoded"
    }

    current_token = csrf_token or get_freshrss_action_token(api_base, auth_token)
    if not current_token:
        logger.error("Cannot mark articles as read: FreshRSS action token 'T' could not be acquired.")
        return 0

    unique_ids = list(set(item_ids))
    batch_size = 50
    marked_total = 0

    logger.info(f"Marking {len(unique_ids)} articles as READ in FreshRSS server API...")

    for i in range(0, len(unique_ids), batch_size):
        chunk = unique_ids[i:i + batch_size]
        payload = [
            ("a", "user/-/state/com.google/read"),
            ("T", current_token)
        ]
        for it_id in chunk:
            payload.append(("i", it_id))

        try:
            r = requests.post(endpoint, headers=headers, data=payload, timeout=20)
            if r.status_code == 200 and "OK" in r.text.upper():
                marked_total += len(chunk)
            elif r.status_code == 400 or "token" in r.text.lower():
                current_token = get_freshrss_action_token(api_base, auth_token)
                if current_token:
                    payload[1] = ("T", current_token)
                    r_retry = requests.post(endpoint, headers=headers, data=payload, timeout=20)
                    if r_retry.status_code == 200:
                        marked_total += len(chunk)
            else:
                logger.warning(f"FreshRSS edit-tag batch failed (HTTP {r.status_code}): {r.text[:150]}")
        except Exception as e:
            logger.warning(f"Error marking batch as read in FreshRSS: {e}")

    logger.info(f"[✓] Successfully marked {marked_total}/{len(unique_ids)} articles as READ in FreshRSS server API.")
    return marked_total


# ==============================================================================
# PostgreSQL Connection and Dynamic Schema Adaptation
# ==============================================================================

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
    ensures vector_indexed and freshrss_id columns exist, and resolves exact column mappings.
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
                WHERE column_name IN ('content', 'clean_content', 'title', 'link', 'url')
                AND table_schema NOT IN ('pg_catalog', 'information_schema')
                GROUP BY table_schema, table_name
                HAVING count(*) >= 2;
            """)
            matched = cur.fetchall()
            if matched:
                target_schema, target_table = matched[0]
                table_type = "articles"

        # 4. Fallback: Auto-create public.rss_articles if no suitable table exists
        if not target_table:
            target_schema = "public"
            target_table = "rss_articles"
            table_type = "articles"
            logger.info("No existing article table found in PostgreSQL. Creating 'public.rss_articles'...")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS public.rss_articles (
                    id VARCHAR(512) PRIMARY KEY,
                    feed_title TEXT,
                    title TEXT,
                    url TEXT,
                    author TEXT,
                    clean_content TEXT,
                    "group" TEXT,
                    published_at BIGINT,
                    fetched_at BIGINT,
                    vector_indexed BOOLEAN DEFAULT FALSE,
                    freshrss_id VARCHAR(512),
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS idx_rss_articles_vector_indexed ON public.rss_articles(vector_indexed);
                CREATE INDEX IF NOT EXISTS idx_rss_articles_published_at ON public.rss_articles(published_at);
                CREATE INDEX IF NOT EXISTS idx_rss_articles_freshrss_id ON public.rss_articles(freshrss_id);
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

        # Ensure freshrss_id column exists
        cur.execute(f"""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                               WHERE table_schema = '{target_schema}' 
                               AND table_name = '{target_table}' 
                               AND column_name = 'freshrss_id') THEN
                    ALTER TABLE {qualified} ADD COLUMN freshrss_id VARCHAR(512);
                END IF;
            END $$;
        """)
        conn.commit()

        # Add indexes for speed
        safe_idx_name = f"idx_vec_{target_table[:20]}"
        try:
            cur.execute(f"CREATE INDEX IF NOT EXISTS {safe_idx_name} ON {qualified} (vector_indexed);")
            cur.execute(f"CREATE INDEX IF NOT EXISTS idx_freshrss_{target_table[:16]} ON {qualified} (freshrss_id);")
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

        # Detect PRIMARY KEY or UNIQUE constraints using system catalog
        unique_columns: Set[str] = set()
        try:
            cur.execute("""
                SELECT DISTINCT a.attname
                FROM pg_class t
                JOIN pg_index ix ON t.oid = ix.indrelid
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
                JOIN pg_namespace n ON n.oid = t.relnamespace
                WHERE n.nspname = %s
                  AND t.relname = %s
                  AND ix.indisunique = true;
            """, (target_schema, target_table))
            for r in cur.fetchall():
                unique_columns.add(r[0].lower())
        except Exception as e_u:
            logger.debug(f"Could not query pg_index: {e_u}")

        logger.info(f"Unique/Primary columns for {qualified}: {sorted(unique_columns)}")

        # Determine ID column
        id_candidates = ("id", "guid", "article_id", "entry_id", "link", "url")
        id_col = next((c for c in id_candidates if c in cols), sorted(cols)[0])
        id_type = col_types.get(id_col, "")
        id_is_int = any(k in id_type for k in ("int", "serial", "bigint", "smallint"))
        id_is_uuid = "uuid" in id_type

        # Determine Title column
        title_candidates = ("title", "headline", "subject", "name")
        title_col = next((c for c in title_candidates if c in cols), None)

        # Determine URL column
        url_candidates = ("url", "link", "canonical", "permalink", "guid")
        url_col = next((c for c in url_candidates if c in cols), None)

        # Determine Feed column (e.g. feed_title in rss_articles, or feed)
        feed_candidates = ("feed_title", "feed", "feed_name", "source", "source_name", "channel", "site_name", "author", "id_feed", "feed_id")
        feed_col = next((c for c in feed_candidates if c in cols), None)

        # Determine Group / Category column (e.g. group in rss_articles, or category)
        group_candidates = ("group", "category", "category_name", "tag", "tags", "categories", "topic", "section")
        group_col = next((c for c in group_candidates if c in cols), None)

        # Determine Content column (e.g. clean_content in rss_articles, or content)
        content_candidates = ("clean_content", "content", "body", "text", "summary", "description", "raw_content", "details")
        content_col = next((c for c in content_candidates if c in cols), None)

        # Author column
        author_candidates = ("author", "creator", "byline")
        author_col = next((c for c in author_candidates if c in cols), None)

        # Fetched At column
        fetched_at_candidates = ("fetched_at", "crawled_at", "created_at")
        fetched_at_col = next((c for c in fetched_at_candidates if c in cols), None)

        # Published At column
        pub_candidates = ("published_at", "pub_date", "pubdate", "date", "published", "created_at", "timestamp", "crawl_time")
        pub_col = next((c for c in pub_candidates if c in cols), None)

        # Vector Indexed column
        vector_indexed_col = "vector_indexed" if "vector_indexed" in cols else None

        # FreshRSS ID column
        freshrss_id_col = "freshrss_id" if "freshrss_id" in cols else None

        # Determine conflict target: ONLY use if a real unique index exists in PostgreSQL
        if id_col and id_col.lower() in unique_columns:
            conflict_target = id_col
        elif url_col and url_col.lower() in unique_columns:
            conflict_target = url_col
        else:
            conflict_target = None

        # SQL expressions for SELECT
        title_expr = f'COALESCE("{title_col}", \'Untitled\')' if title_col else "'Untitled'"
        url_expr = f'COALESCE("{url_col}", \'\')' if url_col else "''"
        feed_expr = f'COALESCE("{feed_col}"::text, \'FreshRSS\')' if feed_col else "'FreshRSS'"
        group_expr = f'COALESCE("{group_col}"::text, \'General\')' if group_col else "'General'"
        content_expr = f'COALESCE("{content_col}", \'\')' if content_col else title_expr
        author_expr = f'COALESCE("{author_col}", \'\')' if author_col else "''"

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
            "cols": cols,
            "col_types": col_types,
            "unique_columns": unique_columns,
            "id_col": id_col,
            "id_is_int": id_is_int,
            "id_is_uuid": id_is_uuid,
            "title_col": title_col,
            "url_col": url_col,
            "feed_col": feed_col,
            "group_col": group_col,
            "content_col": content_col,
            "author_col": author_col,
            "fetched_at_col": fetched_at_col,
            "pub_col": pub_col,
            "vector_indexed_col": vector_indexed_col,
            "freshrss_id_col": freshrss_id_col,
            "conflict_target": conflict_target,
            "title_expr": title_expr,
            "url_expr": url_expr,
            "feed_expr": feed_expr,
            "group_expr": group_expr,
            "content_expr": content_expr,
            "author_expr": author_expr,
            "pub_expr": pub_expr,
            "feed_table": feed_table,
            "category_table": category_table,
        }


# ==============================================================================
# OpenVINO Embeddings (Intel NPU) & Qdrant Operations
# ==============================================================================

def get_embedding(text: str) -> Optional[List[float]]:
    """Single-item embedding generation via OpenVINO server."""
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
    """Generates embeddings for a batch of texts using OpenVINO server on Intel NPU."""
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
    """Verifies Qdrant collection exists and matches EMBED_DIMS. Recreates if missing or mismatched."""
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


# ==============================================================================
# Main Orchestration Loop
# ==============================================================================

def main():
    logger.info("=" * 70)
    logger.info("Starting FreshRSS -> PostgreSQL -> OpenVINO (NPU) -> Qdrant Sync")
    logger.info("=" * 70)

    # 1. Connect to Qdrant
    try:
        qdrant = QdrantClient(url=QDRANT_URL, timeout=15)
        qdrant.get_collections()
        logger.info(f"[✓] Connected to Qdrant at {QDRANT_URL} (collection: {QDRANT_COLLECTION})")
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
                logger.info(f"[✓] PostgreSQL ready on database '{db}', active table {table_info['qualified']}.")
                break
            else:
                conn.close()
                conn = None

    # 3. Check Qdrant collection status; recreate if needed
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

    # 4. Connect to FreshRSS API & fetch all UNREAD articles
    api_base, auth_token = freshrss_login(FRESHRSS_BASE_URL, FRESHRSS_USER, FRESHRSS_API_PASS)
    csrf_token = None
    unread_items: List[Dict[str, Any]] = []

    if api_base and auth_token:
        csrf_token = get_freshrss_action_token(api_base, auth_token)
        unread_items = fetch_unread_freshrss_articles(api_base, auth_token, limit=200, max_pages=20)

    # 5. Check PostgreSQL for existing records & export genuinely new articles
    already_indexed_freshrss_ids: List[str] = []
    new_items_to_insert: List[Dict[str, Any]] = []

    if conn and table_info and unread_items:
        qualified = table_info["qualified"]
        cols: Set[str] = table_info["cols"]
        id_col = table_info["id_col"]
        url_col = table_info["url_col"]
        id_is_int = table_info["id_is_int"]
        id_is_uuid = table_info.get("id_is_uuid", False)
        conflict_target = table_info["conflict_target"]

        # Pre-query existing records by URL and ID to separate already-indexed from new articles
        indexed_urls: Set[str] = set()
        indexed_ids: Set[str] = set()
        unindexed_urls: Set[str] = set()
        unindexed_ids: Set[str] = set()

        all_urls = [it["url"] for it in unread_items if it.get("url")]
        all_ids = [str(it["id"]) for it in unread_items if it.get("id")]

        with conn.cursor() as cur:
            if all_urls and url_col:
                for chunk_idx in range(0, len(all_urls), 500):
                    url_chunk = all_urls[chunk_idx:chunk_idx + 500]
                    cur.execute(f"""
                        SELECT "{url_col}", vector_indexed 
                        FROM {qualified} 
                        WHERE "{url_col}" = ANY(%s);
                    """, (url_chunk,))
                    for r in cur.fetchall():
                        u_val, vec = r[0], bool(r[1])
                        if vec:
                            indexed_urls.add(u_val)
                        else:
                            unindexed_urls.add(u_val)

            # Also check by freshrss_id column or id column
            id_check_col = table_info["freshrss_id_col"] or (id_col if not id_is_int else None)
            if all_ids and id_check_col:
                for chunk_idx in range(0, len(all_ids), 500):
                    id_chunk = all_ids[chunk_idx:chunk_idx + 500]
                    cur.execute(f"""
                        SELECT "{id_check_col}", vector_indexed 
                        FROM {qualified} 
                        WHERE "{id_check_col}" = ANY(%s);
                    """, (id_chunk,))
                    for r in cur.fetchall():
                        i_val, vec = str(r[0]), bool(r[1])
                        if vec:
                            indexed_ids.add(i_val)
                        else:
                            unindexed_ids.add(i_val)

        for it in unread_items:
            u = it.get("url") or ""
            f_id = str(it.get("freshrss_id") or it.get("id") or "")
            if (u and u in indexed_urls) or (f_id and f_id in indexed_ids):
                # Already stored and embedded in Qdrant! Queue for FreshRSS mark-as-read
                already_indexed_freshrss_ids.append(it["freshrss_id"])
            elif (u and u in unindexed_urls) or (f_id and f_id in unindexed_ids):
                # Already in PostgreSQL, will be embedded in Step 6
                pass
            else:
                new_items_to_insert.append(it)

        logger.info(
            f"Unread analysis: {len(already_indexed_freshrss_ids)} already indexed in PostgreSQL/Qdrant (will be marked read), "
            f"{len(new_items_to_insert)} new articles to insert."
        )

        # Insert new articles
        if new_items_to_insert:
            logger.info(f"Exporting {len(new_items_to_insert)} UNREAD articles to PostgreSQL table {qualified}...")
            inserted_count = 0
            error_log_count = 0

            with conn.cursor() as cur:
                for it in new_items_to_insert:
                    # Resolve primary ID according to column data type
                    if id_is_uuid:
                        primary_id = str(uuid.uuid5(uuid.NAMESPACE_URL, str(it["url"] or it["id"])))
                    elif id_is_int:
                        val_str = str(it["id"] or it["url"])
                        if val_str.isdigit():
                            primary_id = int(val_str)
                        elif "item/" in val_str:
                            try:
                                primary_id = int(val_str.split("item/")[-1], 16)
                            except ValueError:
                                primary_id = abs(hash(val_str)) % (2**63 - 1)
                        else:
                            primary_id = abs(hash(val_str)) % (2**63 - 1)
                    else:
                        primary_id = str(it["id"] or it["url"])

                    # Build column value dictionary
                    col_dict: Dict[str, Any] = {}
                    if id_col in cols:
                        col_dict[id_col] = primary_id
                    if table_info["freshrss_id_col"] and table_info["freshrss_id_col"] in cols:
                        col_dict[table_info["freshrss_id_col"]] = it["freshrss_id"]
                    if table_info["title_col"] and table_info["title_col"] in cols:
                        col_dict[table_info["title_col"]] = it["title"]
                    if table_info["url_col"] and table_info["url_col"] in cols:
                        col_dict[table_info["url_col"]] = it["url"]
                    if table_info["feed_col"] and table_info["feed_col"] in cols:
                        col_dict[table_info["feed_col"]] = it["feed"]
                    if table_info["author_col"] and table_info["author_col"] in cols:
                        col_dict[table_info["author_col"]] = it.get("author") or it.get("feed") or ""
                    if table_info["content_col"] and table_info["content_col"] in cols:
                        col_dict[table_info["content_col"]] = it["text"]
                    if table_info["group_col"] and table_info["group_col"] in cols:
                        col_dict[table_info["group_col"]] = it["group"]
                    # Convert published_at to appropriate data type (timestamptz vs bigint/int)
                    if table_info["pub_col"] and table_info["pub_col"] in cols:
                        pub_epoch = it.get("published_at") or int(time.time())
                        if isinstance(pub_epoch, (int, float)):
                            if pub_epoch > 100000000000:
                                pub_epoch = pub_epoch / 1000.0
                            if pub_epoch <= 0:
                                pub_epoch = time.time()
                        else:
                            pub_epoch = time.time()

                        pub_dtype = table_info["col_types"].get(table_info["pub_col"], "")
                        if "timestamp" in pub_dtype or "date" in pub_dtype:
                            col_dict[table_info["pub_col"]] = datetime.datetime.fromtimestamp(pub_epoch, tz=timezone.utc)
                        else:
                            col_dict[table_info["pub_col"]] = int(pub_epoch)

                    # Convert fetched_at to appropriate data type (timestamptz vs bigint/int)
                    if table_info["fetched_at_col"] and table_info["fetched_at_col"] in cols:
                        fetched_dtype = table_info["col_types"].get(table_info["fetched_at_col"], "")
                        if "timestamp" in fetched_dtype or "date" in fetched_dtype:
                            col_dict[table_info["fetched_at_col"]] = datetime.datetime.now(timezone.utc)
                        else:
                            col_dict[table_info["fetched_at_col"]] = int(time.time())

                    if table_info["vector_indexed_col"] and table_info["vector_indexed_col"] in cols:
                        col_dict[table_info["vector_indexed_col"]] = False

                    col_names = list(col_dict.keys())
                    col_names_quoted = [f'"{c}"' for c in col_names]
                    placeholders = ["%s"] * len(col_names)
                    values = [col_dict[c] for c in col_names]

                    if conflict_target and conflict_target in col_dict:
                        update_cols = [c for c in col_names if c != conflict_target]
                        if update_cols:
                            update_sql = ", ".join(f'"{c}" = EXCLUDED."{c}"' for c in update_cols)
                            insert_sql = f"""
                                INSERT INTO {qualified} ({", ".join(col_names_quoted)})
                                VALUES ({", ".join(placeholders)})
                                ON CONFLICT ("{conflict_target}") DO UPDATE SET {update_sql};
                            """
                        else:
                            insert_sql = f"""
                                INSERT INTO {qualified} ({", ".join(col_names_quoted)})
                                VALUES ({", ".join(placeholders)})
                                ON CONFLICT ("{conflict_target}") DO NOTHING;
                            """
                    else:
                        insert_sql = f"""
                            INSERT INTO {qualified} ({", ".join(col_names_quoted)})
                            VALUES ({", ".join(placeholders)});
                        """

                    try:
                        cur.execute("SAVEPOINT sp_insert_item;")
                        cur.execute(insert_sql, tuple(values))
                        cur.execute("RELEASE SAVEPOINT sp_insert_item;")
                        if cur.rowcount > 0:
                            inserted_count += 1
                    except Exception as e_ins:
                        cur.execute("ROLLBACK TO SAVEPOINT sp_insert_item;")
                        if error_log_count < 5:
                            logger.warning(f"Insert error for '{it['title'][:40]}': {e_ins}")
                            error_log_count += 1

                conn.commit()
                logger.info(f"[✓] Exported {inserted_count} new articles to PostgreSQL {qualified}.")

    # 6. Fetch unindexed records from PostgreSQL, embed with OpenVINO (Intel NPU),
    #    upsert into Qdrant, and update vector_indexed=TRUE
    total_embedded = 0
    newly_embedded_freshrss_ids: List[str] = []

    if conn and table_info:
        qualified = table_info["qualified"]
        id_col = table_info["id_col"]
        id_is_int = table_info["id_is_int"]
        has_freshrss_col = table_info["freshrss_id_col"] is not None

        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(f"SELECT COUNT(*) FROM {qualified} WHERE vector_indexed IS FALSE OR vector_indexed IS NULL;")
            total_unindexed = cur.fetchone()[0]
            logger.info(f"Articles requiring embedding in PostgreSQL: {total_unindexed:,}")

            if total_unindexed > 0:
                batch_size = 50
                processed = 0

                freshrss_sel = f'"{table_info["freshrss_id_col"]}"' if has_freshrss_col else f'"{id_col}"'

                if table_info["type"] == "freshrss" and table_info["feed_table"]:
                    select_sql = f"""
                        SELECT e."{id_col}" AS id,
                               e.{freshrss_sel} AS freshrss_id,
                               e.title AS title,
                               COALESCE(e.link, '') AS url,
                               COALESCE(f.name, 'FreshRSS') AS feed,
                               COALESCE(c.name, 'General') AS "group",
                               EXTRACT(EPOCH FROM COALESCE(e.date, CURRENT_TIMESTAMP))::bigint AS published_at,
                               COALESCE(e.content, '') AS text
                        FROM {qualified} e
                        LEFT JOIN {table_info['feed_table']} f ON e.id_feed = f.id
                        LEFT JOIN {table_info['category_table'] or "f"} c ON f.category = c.id
                        WHERE e.vector_indexed IS FALSE OR e.vector_indexed IS NULL
                        LIMIT {batch_size};
                    """
                else:
                    select_sql = f"""
                        SELECT "{id_col}" AS id,
                               {freshrss_sel} AS freshrss_id,
                               {table_info['title_expr']} AS title,
                               {table_info['url_expr']} AS url,
                               {table_info['feed_expr']} AS feed,
                               {table_info['group_expr']} AS "group",
                               {table_info['pub_expr']} AS published_at,
                               {table_info['content_expr']} AS text
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
                        text = row.get("text") or title
                        clean_text = re.sub(r"<[^>]+>", " ", str(text))
                        clean_text = re.sub(r"\s+", " ", clean_text).strip() or title
                        url_val = row.get("url") or ""
                        feed_val = row.get("feed") or "News"
                        group_val = row.get("group") or "General"
                        pub_time = row.get("published_at") or int(time.time())

                        # FreshRSS ID tracking
                        f_id = row.get("freshrss_id")
                        if not f_id or f_id == str(row["id"]):
                            if str(row["id"]).startswith("tag:google.com"):
                                f_id = str(row["id"])

                        embed_text = f"{title}\n{clean_text}"
                        texts_to_embed.append(embed_text)

                        row_metadata.append({
                            "raw_id": row["id"],
                            "freshrss_id": f_id,
                            "title": title,
                            "url": url_val,
                            "feed": feed_val,
                            "group": group_val,
                            "published_at": int(pub_time),
                            "text": clean_text
                        })

                    # Generate embeddings via OpenVINO on Intel NPU
                    vectors = get_embeddings_batch(texts_to_embed)

                    points_to_upsert = []
                    processed_ids = []
                    batch_freshrss_ids = []

                    for meta, vec in zip(row_metadata, vectors):
                        if vec and len(vec) == EMBED_DIMS:
                            pt_id = str(uuid.uuid5(uuid.NAMESPACE_URL, str(meta["raw_id"] or meta["url"])))
                            # Payload keys match sample.txt: title, url, feed, group, published_at, text
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
                            if meta.get("freshrss_id"):
                                batch_freshrss_ids.append(meta["freshrss_id"])

                    if points_to_upsert:
                        # Upsert to Qdrant collection
                        qdrant.upsert(collection_name=QDRANT_COLLECTION, points=points_to_upsert)

                        # Update vector_indexed=TRUE in PostgreSQL
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
                        total_embedded += len(points_to_upsert)
                        pct = (processed / total_unindexed) * 100
                        logger.info(f"Embedded & Upserted: {processed:,} / {total_unindexed:,} ({pct:.1f}%) into Qdrant '{QDRANT_COLLECTION}'...")
                        newly_embedded_freshrss_ids.extend(batch_freshrss_ids)
                    else:
                        logger.warning("No vectors generated for current batch. Checking embedding service...")
                        time.sleep(2)

        conn.close()

    # 7. Fallback direct embedding if PostgreSQL was not available, but unread items exist
    col_now = qdrant.get_collection(QDRANT_COLLECTION)
    if (col_now.points_count or 0) == 0 and unread_items and total_embedded == 0:
        logger.info(f"PostgreSQL empty or offline. Embedding {len(unread_items)} FreshRSS items directly into Qdrant...")
        texts = [f"{it['title']}\n{it['text']}" for it in unread_items]
        vectors = get_embeddings_batch(texts)
        points = []
        direct_marked_ids = []

        for it, vec in zip(unread_items, vectors):
            if vec and len(vec) == EMBED_DIMS:
                pt_id = str(uuid.uuid5(uuid.NAMESPACE_URL, str(it["id"] or it["url"])))
                points.append(PointStruct(id=pt_id, vector=vec, payload={
                    "title": it["title"],
                    "url": it["url"],
                    "feed": it["feed"],
                    "group": it["group"],
                    "published_at": it["published_at"],
                    "text": it["text"]
                }))
                direct_marked_ids.append(it["id"])

        if points:
            qdrant.upsert(collection_name=QDRANT_COLLECTION, points=points)
            logger.info(f"[✓] Directly upserted {len(points)} points into Qdrant.")
            newly_embedded_freshrss_ids.extend(direct_marked_ids)

    # 8. MARK AS READ IN FRESHRSS API:
    # Mark both already-indexed articles and newly-embedded articles as read!
    all_to_mark = list(set(already_indexed_freshrss_ids + newly_embedded_freshrss_ids))
    if api_base and auth_token and all_to_mark:
        mark_freshrss_items_read(api_base, auth_token, csrf_token, all_to_mark)
    elif api_base and auth_token and not all_to_mark:
        logger.info("No unread articles pending mark-as-read.")

    # 9. Report final metrics
    final_count = qdrant.get_collection(QDRANT_COLLECTION).points_count or 0
    logger.info("=" * 70)
    logger.info(f"Sync complete. Total points in Qdrant '{QDRANT_COLLECTION}': {final_count:,}.")
    logger.info("=" * 70)


if __name__ == "__main__":
    main()
