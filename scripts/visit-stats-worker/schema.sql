-- Idempotent migration for existing D1 deployments. Preserve historical daily records.
-- Existing table may contain legacy per-page rows; new Worker only writes 'site'.
CREATE TABLE IF NOT EXISTS daily_uniques (
  day TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('site', 'page')),
  page TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  PRIMARY KEY (day, scope, page, visitor_hash)
) WITHOUT ROWID;

-- Historical unique IPs: stable keyed HMAC, NOT a raw IP address.
-- Retained across dates to count the same public IP only once over time.
-- Starts when the new Worker first handles a visit; old daily hashes cannot
-- be converted into all-time hashes, so historical figures cannot be backfilled.
CREATE TABLE IF NOT EXISTS historical_uniques (
  visitor_hash TEXT PRIMARY KEY NOT NULL,
  first_seen_day TEXT NOT NULL
) WITHOUT ROWID;
