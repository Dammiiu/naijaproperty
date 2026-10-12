-- Naijaproperty: extensions and baseline schema hardening.
-- Runs once, on first initialisation of an empty Postgres data directory.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS citext;

-- Guard against accidental cross-tenant writes: every app connection must
-- carry a non-empty application_name so connection pools are traceable.
ALTER SYSTEM SET log_min_duration_statement = 500;
