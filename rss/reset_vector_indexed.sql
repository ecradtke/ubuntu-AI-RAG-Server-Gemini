-- Reset vector_indexed flag across all article and entry tables in PostgreSQL
DO $$
DECLARE
    r RECORD;
BEGIN
    -- Reset public.articles if exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'articles') THEN
        UPDATE articles SET vector_indexed = FALSE;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'rss_items') THEN
        UPDATE rss_items SET vector_indexed = FALSE;
    END IF;
    -- Reset any table with a vector_indexed column
    FOR r IN (
        SELECT table_schema, table_name 
        FROM information_schema.columns 
        WHERE column_name = 'vector_indexed' 
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
    ) LOOP
        EXECUTE format('UPDATE %I.%I SET vector_indexed = FALSE;', r.table_schema, r.table_name);
    END LOOP;
END $$;
