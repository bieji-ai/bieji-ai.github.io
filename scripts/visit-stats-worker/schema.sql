-- One distinct IP per Shanghai-calendar-day, once per site and once per page.
-- Only HMAC pseudonyms are retained. Raw IPs must never be stored.
CREATE TABLE IF NOT EXISTS daily_uniques (
  day TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('site', 'page')),
  page TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  PRIMARY KEY (day, scope, page, visitor_hash)
) WITHOUT ROWID;
