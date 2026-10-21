-- Reset vector_indexed flag so all articles are re-embedded into Qdrant
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'articles') THEN
        UPDATE articles SET vector_indexed = FALSE;
    END IF;
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'rss_items') THEN
        UPDATE rss_items SET vector_indexed = FALSE;
    END IF;
END $$;
