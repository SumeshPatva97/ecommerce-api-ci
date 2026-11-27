-- DEC-12 real-database tests — READ-ONLY preflight for `ecommerce_test`.
--
-- NOT EXECUTED — requires explicit owner authorization (DEC-12).
--
-- Run by the owner (step 3 of tests/db/README.md) with the TEST user, before any test:
--   mysql --defaults-extra-file=<git-ignored option file> ecommerce_test -e "source tests/db/sql/setup.sql"
--
-- Writes nothing. Test data is inserted by the TypeScript fixtures (tests/db/harness/fixtures.ts,
-- reusing prisma/seed/*.seed.ts for states / settings / notification templates) and removed by
-- tests/db/sql/cleanup.sql — both only inside ecommerce_test.
--
-- The first statement aborts the script (ERROR 1242) when the current database is not exactly
-- ecommerce_test.

SET @db_guard = (SELECT 1 FROM DUAL WHERE NOT (DATABASE() <=> 'ecommerce_test') UNION ALL SELECT 1 FROM DUAL WHERE NOT (DATABASE() <=> 'ecommerce_test'));

-- 1. Where am I? (expected: ecommerce_test; MySQL 8.4.x; REPEATABLE-READ)
SELECT DATABASE() AS current_database, @@version AS server_version,
       @@transaction_isolation AS isolation, @@innodb_lock_wait_timeout AS lock_wait_timeout_s;

-- 2. Baseline applied by the migration identity (expected: one row, 20261117160425_baseline,
--    finished_at NOT NULL, rolled_back_at NULL).
SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
FROM _prisma_migrations ORDER BY started_at;

-- 3. Schema shape (expected: 68 = 67 application tables + _prisma_migrations).
SELECT COUNT(*) AS table_count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE();

-- 4. Grants of the TEST user (expected: SELECT, INSERT, UPDATE, DELETE on `ecommerce_test`.* only;
--    no DROP / ALTER / CREATE / GRANT, nothing on ecommerce_dev or *.*).
SHOW GRANTS FOR CURRENT_USER();

-- 5. Starting state (expected: empty result = every application table empty; TABLE_ROWS is an
--    InnoDB estimate, the harness re-checks exact counts after its own cleanup).
SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> '_prisma_migrations' AND TABLE_ROWS > 0
ORDER BY TABLE_NAME;
