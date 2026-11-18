-- pg_trgm lives in public on Neon; search_path must include public for gin_trgm_ops.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
