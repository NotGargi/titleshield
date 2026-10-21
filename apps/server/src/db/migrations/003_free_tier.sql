-- 003: Free-tier data sources. Searches start from a real address (any address in India);
-- agents use TinyFish Search + Fetch only; keys can be saved from the app.

ALTER TABLE title_searches
  ADD COLUMN IF NOT EXISTS address_text TEXT,
  ADD COLUMN IF NOT EXISTS locality VARCHAR(160),
  ADD COLUMN IF NOT EXISTS pincode VARCHAR(10),
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS location_json JSONB;
ALTER TABLE title_searches ALTER COLUMN portal_mode SET DEFAULT 'live';

ALTER TABLE tinyfish_agent_runs DROP CONSTRAINT IF EXISTS tinyfish_agent_runs_status_check;
ALTER TABLE tinyfish_agent_runs ADD CONSTRAINT tinyfish_agent_runs_status_check
  CHECK (status IN ('STREAMING', 'SUCCESS', 'TIMEOUT', 'CAPTCHA_BLOCKED', 'PORTAL_DOWN', 'NO_RECORD', 'FAILED', 'NOT_CONFIGURED', 'RATE_LIMITED'));
ALTER TABLE tinyfish_agent_runs ADD COLUMN IF NOT EXISTS search_log JSONB;

-- Cached TinyFish / geocoder responses (saves free quota; monitoring bypasses it).
CREATE TABLE IF NOT EXISTS web_cache (
  cache_key CHAR(64) PRIMARY KEY,
  kind VARCHAR(20) NOT NULL,
  request JSONB NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Free-tier usage counters (search requests, fetched URLs) per UTC day.
CREATE TABLE IF NOT EXISTS tinyfish_usage (
  day DATE NOT NULL,
  kind VARCHAR(10) NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

-- API keys saved from the Settings page (AES-256-GCM encrypted).
CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(60) PRIMARY KEY,
  value_enc TEXT NOT NULL,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TABLE IF EXISTS replay_overlays;
DELETE FROM portal_cache;
