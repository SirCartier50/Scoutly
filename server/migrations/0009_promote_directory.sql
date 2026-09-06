-- Promotes every verified directory entry into the actively-fetched
-- `companies` table. This is the other half of the "everyone gets every
-- company by default" pivot (0008): the directory was previously just a
-- searchable catalog a user could pull individual entries from into their
-- own list; now the whole catalog IS the list everyone gets, fetched by the
-- cron a few times a day (see check.ts's doc comment on why that requires
-- Workers Paid rather than the Free plan's 50-subrequest ceiling).
--
-- OR IGNORE (rather than an ON CONFLICT upsert clause, which SQLite's
-- parser rejects after this INSERT...SELECT form) keeps whatever's already
-- in `companies` untouched - a company someone already hand-verified this
-- session, e.g. Uber's corrected oraclehcm entry, isn't clobbered by the
-- directory's own copy of it.
INSERT OR IGNORE INTO companies (slug, name, careers_url, ats_type, board_token, topics, source, health, yield_history, consecutive_zero, created_at)
SELECT slug, name, careers_url, ats_type, board_token, topics, 'directory', 'ok', '[]', 0, datetime('now')
FROM directory;
