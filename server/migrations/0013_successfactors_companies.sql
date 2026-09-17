-- Industry leaders on SAP SuccessFactors Career Site Builder, onboarded with
-- the successfactors connector. board_token is each career site's host,
-- found from the company's own careers pages; every row was verified live
-- (the site's sitemap or search returned real jobs) before being included.
--
-- Removed after review: PwC -> careers.pwc.com is PwC MIDDLE EAST (all 51 jobs
-- in Dubai, none in the US); it would have filed Middle East roles under "PwC".
-- Puig was excluded because it runs legacy SuccessFactors, not Career Site Builder.

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('bmw-group', 'BMW Group', 'https://jobs.bmwgroup.com/', 'successfactors', 'jobs.bmwgroup.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('coty', 'Coty', 'https://careers.coty.com/', 'successfactors', 'careers.coty.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('crocs', 'Crocs', 'https://careers.crocs.com/', 'successfactors', 'careers.crocs.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('exxonmobil', 'ExxonMobil', 'https://jobs.exxonmobil.com/', 'successfactors', 'jobs.exxonmobil.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('ey', 'EY', 'https://careers.ey.com/', 'successfactors', 'careers.ey.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('john-deere', 'John Deere', 'https://jobs.deere.com/', 'successfactors', 'jobs.deere.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('kellanova', 'Kellanova', 'https://jobs.kellanova.com/', 'successfactors', 'jobs.kellanova.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('lionsgate', 'Lionsgate', 'https://jobs.lionsgate.com/', 'successfactors', 'jobs.lionsgate.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('mcdonald-s', 'McDonald''s', 'https://jobs.mcdonalds.com/', 'successfactors', 'jobs.mcdonalds.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('nextera-energy', 'NextEra Energy', 'https://jobs.nexteraenergy.com/', 'successfactors', 'jobs.nexteraenergy.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('paramount', 'Paramount', 'https://careers.paramount.com/', 'successfactors', 'careers.paramount.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('prada-group', 'Prada Group', 'https://jobs.pradagroup.com/', 'successfactors', 'jobs.pradagroup.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('sephora', 'Sephora', 'https://jobs.sephora.com/', 'successfactors', 'jobs.sephora.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('shiseido', 'Shiseido', 'https://careers.shiseido.com/', 'successfactors', 'careers.shiseido.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('the-hershey-company', 'The Hershey Company', 'https://careers.thehersheycompany.com/', 'successfactors', 'careers.thehersheycompany.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('under-armour', 'Under Armour', 'https://careers.underarmour.com/', 'successfactors', 'careers.underarmour.com', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

-- PwC US instead: its own Workday tenant, using the dedicated US entry-level
-- board (446 jobs when verified) rather than the Middle East site above.
INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('pwc', 'PwC', 'https://pwc.wd3.myworkdayjobs.com/US_Entry_Level_Careers', 'workday', NULL, '{"kind":"json-endpoint","url":"https://pwc.wd3.myworkdayjobs.com/wday/cxs/pwc/US_Entry_Level_Careers/jobs"}', 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;
