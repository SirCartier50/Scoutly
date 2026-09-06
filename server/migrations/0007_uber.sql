-- Uber: the row 0002_directory.sql added pointed at SmartRecruiters
-- ('uber' board token), which turns out to resolve to a single dummy "Test
-- UAT" posting, not Uber's real board - SmartRecruiters was never Uber's
-- actual ATS. Uber's real career site (jobs.uber.com) runs on Oracle Fusion
-- Cloud Recruiting, found by inspecting live network traffic the same way as
-- the Amazon/Microsoft/Google/Apple connectors. Confirmed against the live
-- API: 666 real open postings, correct pagination, working apply links.
--
-- board_token packs the three tenant-specific values the oraclehcm connector
-- needs and can't derive from each other: "<host>|<siteNumber>|<siteName>".
INSERT INTO directory (slug, name, careers_url, ats_type, board_token, topics, job_count, verified_at)
VALUES
  ('uber', 'Uber', 'https://jobs.uber.com', 'oraclehcm',
   'iaziqy.fa.ocs.oraclecloud.com|CX_1|UberCareers',
   '["mobility","logistics","infra"]', 666, datetime('now'))
ON CONFLICT(slug) DO UPDATE SET
  careers_url = excluded.careers_url,
  ats_type = excluded.ats_type,
  board_token = excluded.board_token,
  job_count = excluded.job_count,
  verified_at = excluded.verified_at;

-- Same fix for any company that already added the broken SmartRecruiters
-- version to their watch list before this correction shipped.
UPDATE companies
SET ats_type = 'oraclehcm',
    board_token = 'iaziqy.fa.ocs.oraclecloud.com|CX_1|UberCareers'
WHERE slug = 'uber' AND ats_type = 'smartrecruiters';
