-- Clean up the failed manual-add attempts from testing Google/Netflix/IBM.
DELETE FROM companies WHERE id IN (17, 18, 19, 20);

-- Amazon and Microsoft: dedicated hand-verified connectors, since neither
-- runs on any of the four public ATS platforms the free probe checks.
INSERT INTO directory (slug, name, careers_url, ats_type, board_token, topics, job_count, verified_at)
VALUES
  ('amazon', 'Amazon', 'https://www.amazon.jobs/content/en/career-programs/university', 'amazonjobs', 'amazon', '["ecommerce","infra","enterprise"]', 373, datetime('now')),
  ('microsoft', 'Microsoft', 'https://apply.careers.microsoft.com', 'microsoftjobs', 'microsoft', '["enterprise","infra","ai-ml"]', 31, datetime('now'))
ON CONFLICT(slug) DO UPDATE SET
  ats_type = excluded.ats_type,
  board_token = excluded.board_token,
  job_count = excluded.job_count,
  verified_at = excluded.verified_at;
