SELECT enumlabel AS status
FROM pg_enum
JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
WHERE typname = 'ListingStatus'
ORDER BY enumsortorder;

SELECT table_name
FROM information_schema.tables
WHERE table_name = 'rate_limit_counters';
