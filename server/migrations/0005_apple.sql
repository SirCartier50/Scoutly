-- Apple: reverse-engineered from the real page's React Router SSR hydration
-- blob (window.__staticRouterHydrationData), server-rendered and reachable
-- with a plain fetch - the earlier bot-block was a different, more sensitive
-- internal API endpoint, not this page.
INSERT INTO directory (slug, name, careers_url, ats_type, board_token, topics, job_count, verified_at)
VALUES
  ('apple', 'Apple', 'https://jobs.apple.com/en-us/search', 'applejobs', 'apple', '["consumer","hardware","infra","ai-ml"]', 88, datetime('now'))
ON CONFLICT(slug) DO UPDATE SET
  ats_type = excluded.ats_type,
  board_token = excluded.board_token,
  job_count = excluded.job_count,
  verified_at = excluded.verified_at;
