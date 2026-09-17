-- Major employers on search-only job platforms the directory couldn't cover
-- before: Netflix on Eightfold and Victoria's Secret on m-cloud's hosted jobs
-- API. Both were hand-verified against the live API (scripts/connector-check.ts
-- exercises the same targets) before being added.
--
-- board_token carries each platform's company identifier: the Eightfold
-- domain, and the m-cloud organisation id from the careers site's org_id.
-- Warner Bros. was also requested - it's already in the directory (Workday).

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('netflix', 'Netflix', 'https://explore.jobs.netflix.net', 'eightfold', 'netflix.com', NULL, 'manual', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('victorias-secret', 'Victoria''s Secret', 'https://careers.victoriassecret.com/en/job-search-results/', 'mcloud', '382ab4db-03e8-40cc-b413-51539aca9954', NULL, 'manual', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;
