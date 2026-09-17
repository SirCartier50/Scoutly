-- Industry-leading companies onboarded via scripts/discover-titans.mjs from
-- the hand-curated data/titans.json. Each company's job platform was found
-- from its own careers pages and every row below was verified against that
-- platform's live API (real postings returned) before being included.
-- Review before applying.
--
-- Removed after manual review, despite passing live verification:
--   Deloitte -> SmartRecruiters "Deloitte6" is Deloitte Africa (Nigeria, South
--     Africa, Ghana...), not the US firm - it would have filed foreign roles
--     under the Deloitte name.
--   Hudson River Trading -> "hrttalentcommunity" is a talent-pool sign-up
--     board ("Campus Talent Community"), not real openings.
-- Verification proves a board has postings, not that it is the company's
-- main US board - which is why these migrations are reviewed before applying.

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('kenvue', 'Kenvue', 'https://kenvue.wd5.myworkdayjobs.com/kenvue', 'workday', NULL, '{"kind":"json-endpoint","url":"https://kenvue.wd5.myworkdayjobs.com/wday/cxs/kenvue/kenvue/jobs"}', 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('tapestry', 'Tapestry', 'https://tapestry.wd108.myworkdayjobs.com/Tapestry_Careers', 'workday', NULL, '{"kind":"json-endpoint","url":"https://tapestry.wd108.myworkdayjobs.com/wday/cxs/tapestry/Tapestry_Careers/jobs"}', 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('american-eagle-outfitters', 'American Eagle Outfitters', 'https://hcml.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/AEO-Careers/requisitions', 'oraclehcm', 'hcml.fa.us2.oraclecloud.com|AEO-Careers|AEO-Careers', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('patagonia', 'Patagonia', 'https://patagonia.wd503.myworkdayjobs.com/PWCareers', 'workday', NULL, '{"kind":"json-endpoint","url":"https://patagonia.wd503.myworkdayjobs.com/wday/cxs/patagonia/PWCareers/jobs"}', 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('on', 'On', 'https://job-boards.greenhouse.io/onrunning', 'greenhouse', 'onrunning', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('general-mills', 'General Mills', 'https://genmills.wd1.myworkdayjobs.com/GMI_External_Careers', 'workday', NULL, '{"kind":"json-endpoint","url":"https://genmills.wd1.myworkdayjobs.com/wday/cxs/genmills/GMI_External_Careers/jobs"}', 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('nfl', 'NFL', 'https://job-boards.greenhouse.io/nflcareers', 'greenhouse', 'nflcareers', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('visa', 'Visa', 'https://visa.wd5.myworkdayjobs.com/Visa', 'workday', NULL, '{"kind":"json-endpoint","url":"https://visa.wd5.myworkdayjobs.com/wday/cxs/visa/Visa/jobs"}', 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;

INSERT INTO companies (slug, name, careers_url, ats_type, board_token, parse_config, source, health, yield_history, consecutive_zero, created_at)
VALUES ('lazard', 'Lazard', 'https://icbpjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/LazardProfessionalCareers/requisitions', 'oraclehcm', 'icbpjb.fa.ocs.oraclecloud.com|LazardProfessionalCareers|LazardProfessionalCareers', NULL, 'discovery', 'ok', '[]', 0, datetime('now'))
ON CONFLICT(slug) DO NOTHING;
