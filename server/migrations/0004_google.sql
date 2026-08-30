-- Google: reverse-engineered from the real page's embedded AF_initDataCallback
-- data block (server-rendered, no browser needed to fetch it - the site was
-- wrongly assumed unreachable on first inspection).
INSERT INTO directory (slug, name, careers_url, ats_type, board_token, topics, job_count, verified_at)
VALUES
  ('google', 'Google', 'https://www.google.com/about/careers/applications/jobs/results/', 'googlejobs', 'google', '["ai-ml","infra","enterprise","consumer"]', 184, datetime('now'))
ON CONFLICT(slug) DO UPDATE SET
  ats_type = excluded.ats_type,
  board_token = excluded.board_token,
  job_count = excluded.job_count,
  verified_at = excluded.verified_at;
