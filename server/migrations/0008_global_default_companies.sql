-- Pivot: no more per-user watch list. Every approved company in `companies`
-- is fetched for and visible to every user by default - the whole point of
-- this app is to never rely on a user remembering to add a well-known
-- company in the first place. Per-user state is now purely a *lens*
-- (settings-based filtering in the Postings tab, application-status
-- tracking) never a *selection* of which companies exist for them.
--
-- user_companies is gone: nothing reads "is user X watching company Y"
-- anymore. The cron fetch loop iterates every row in `companies`; the
-- per-user notify pass iterates every row in `users`.
DROP INDEX IF EXISTS idx_user_companies_company;
DROP TABLE IF EXISTS user_companies;

-- Replaces the old flow where a user typing an unknown company name
-- triggered a live probe/Scout/browser-render attempt inline (which is what
-- produced the wrong Uber SmartRecruiters match in 0002_directory.sql - an
-- unverified automatic result silently trusted). Now it's a ticket: someone
-- (today, the app owner by hand; later, an automated Scout pass) verifies
-- and resolves it deliberately before the company is ever added to the
-- global list everyone fetches.
CREATE TABLE company_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  careers_url         TEXT,
  requested_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_at        TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'pending', -- pending | resolved | rejected
  resolved_company_id INTEGER REFERENCES companies(id),
  note                TEXT
);
CREATE INDEX idx_company_requests_status ON company_requests(status, requested_at);
