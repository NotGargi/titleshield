-- 002: Platform tables around the blueprint schema: tenants & auth, live event log,
-- portal cache/circuit breaker, escrow audit trail, eSign, DPDP consent, advocate
-- reviews, continuous monitoring, Merkle anchors, webhooks and the sandbox trustee bank.

-- ---------- title_searches extensions ----------
ALTER TABLE title_searches
  ADD COLUMN IF NOT EXISTS hobli_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS portal_mode VARCHAR(10) NOT NULL DEFAULT 'replay',
  ADD COLUMN IF NOT EXISTS workflow_id VARCHAR(120),
  ADD COLUMN IF NOT EXISTS verdict VARCHAR(30),
  ADD COLUMN IF NOT EXISTS escrow_action VARCHAR(30),
  ADD COLUMN IF NOT EXISTS assessment JSONB,
  ADD COLUMN IF NOT EXISTS output_json JSONB,
  ADD COLUMN IF NOT EXISTS certificate_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS failure_reason TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS client_reference VARCHAR(120);

-- ---------- tenants / auth ----------
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(160) NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('RETAIL', 'BANK', 'PLATFORM')),
  webhook_url TEXT,
  webhook_secret TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
  email VARCHAR(200) NOT NULL UNIQUE,
  full_name VARCHAR(200) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('BUYER', 'SELLER', 'ADVOCATE', 'BANK_OFFICER', 'ADMIN')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
  label VARCHAR(120) NOT NULL,
  key_prefix VARCHAR(16) NOT NULL,
  key_hash CHAR(64) NOT NULL UNIQUE,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idem_key VARCHAR(120) NOT NULL,
  tenant_id UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  search_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, idem_key)
);

-- ---------- live event log (SSE replay + audit) ----------
CREATE TABLE IF NOT EXISTS search_events (
  event_id BIGSERIAL PRIMARY KEY,
  search_id UUID NOT NULL REFERENCES title_searches(search_id),
  event VARCHAR(60) NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_search_events_search ON search_events (search_id, event_id);

-- ---------- portal cache + circuit breaker (PDF §10) ----------
CREATE TABLE IF NOT EXISTS portal_cache (
  portal_code VARCHAR(40) NOT NULL,
  property_hash CHAR(64) NOT NULL,
  extracted_json JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (portal_code, property_hash)
);

CREATE TABLE IF NOT EXISTS portal_health (
  portal_code VARCHAR(40) PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_at TIMESTAMPTZ,
  open_until TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ
);

ALTER TABLE tinyfish_agent_runs
  ADD COLUMN IF NOT EXISTS agent_role VARCHAR(20),
  ADD COLUMN IF NOT EXISTS mode VARCHAR(10),
  ADD COLUMN IF NOT EXISTS streaming_url TEXT,
  ADD COLUMN IF NOT EXISTS error TEXT,
  ADD COLUMN IF NOT EXISTS from_cache BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tinyfish_agent_runs DROP CONSTRAINT IF EXISTS tinyfish_agent_runs_status_check;
ALTER TABLE tinyfish_agent_runs ADD CONSTRAINT tinyfish_agent_runs_status_check
  CHECK (status IN ('STREAMING', 'SUCCESS', 'TIMEOUT', 'CAPTCHA_BLOCKED', 'PORTAL_DOWN', 'NO_RECORD', 'FAILED'));

-- ---------- uploaded / downloaded documents (vernacular pipeline) ----------
CREATE TABLE IF NOT EXISTS documents (
  document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID REFERENCES title_searches(search_id),
  kind VARCHAR(30) NOT NULL,
  filename VARCHAR(255),
  mime_type VARCHAR(100),
  sha256 CHAR(64) NOT NULL,
  storage_uri TEXT NOT NULL,
  pages INTEGER,
  language VARCHAR(20),
  extracted_json JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'UPLOADED',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- escrow extensions ----------
-- Account numbers are stored AES-256-GCM encrypted (PDF §12), so widen to TEXT.
ALTER TABLE title_escrow_contracts
  ALTER COLUMN buyer_refund_account_no TYPE TEXT,
  ALTER COLUMN seller_payout_account_no TYPE TEXT,
  ADD COLUMN IF NOT EXISTS buyer_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS seller_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS buyer_account_mask VARCHAR(20),
  ADD COLUMN IF NOT EXISTS seller_account_mask VARCHAR(20),
  ADD COLUMN IF NOT EXISTS seller_penny_drop_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS seller_penny_drop_match VARCHAR(20),
  ADD COLUMN IF NOT EXISTS amount_deposited_inr NUMERIC(15, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settlement_amount_inr NUMERIC(15, 2),
  ADD COLUMN IF NOT EXISTS settlement_instruction JSONB,
  ADD COLUMN IF NOT EXISTS agreement_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS buyer_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS seller_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by UUID;

CREATE TABLE IF NOT EXISTS escrow_events (
  id BIGSERIAL PRIMARY KEY,
  escrow_id UUID NOT NULL REFERENCES title_escrow_contracts(escrow_id),
  from_state VARCHAR(40),
  to_state VARCHAR(40) NOT NULL,
  actor VARCHAR(80) NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS esign_sessions (
  esign_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id UUID NOT NULL REFERENCES title_escrow_contracts(escrow_id),
  party VARCHAR(10) NOT NULL CHECK (party IN ('BUYER', 'SELLER')),
  signer_name VARCHAR(200) NOT NULL,
  aadhaar_last4 CHAR(4) NOT NULL,
  otp_hash CHAR(64) NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'OTP_SENT' CHECK (status IN ('OTP_SENT', 'SIGNED', 'FAILED', 'EXPIRED')),
  signature_sha256 CHAR(64),
  expires_at TIMESTAMPTZ NOT NULL,
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DPDP Act 2023 consent artifacts
CREATE TABLE IF NOT EXISTS consent_artifacts (
  consent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_name VARCHAR(200) NOT NULL,
  principal_user_id UUID,
  purpose VARCHAR(80) NOT NULL,
  notice_text TEXT NOT NULL,
  notice_sha256 CHAR(64) NOT NULL,
  search_id UUID,
  escrow_id UUID,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  withdrawn_at TIMESTAMPTZ
);

-- ---------- human-in-the-loop ----------
CREATE TABLE IF NOT EXISTS advocate_reviews (
  review_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID NOT NULL UNIQUE REFERENCES title_searches(search_id),
  reason TEXT NOT NULL,
  sla_due_at TIMESTAMPTZ NOT NULL,
  advocate_user_id UUID,
  decision VARCHAR(10) CHECK (decision IN ('APPROVE', 'REJECT')),
  notes TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- continuous escrow monitoring (TinyFish Monitor role, PDF §3.4) ----------
CREATE TABLE IF NOT EXISTS monitor_subscriptions (
  subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID NOT NULL REFERENCES title_searches(search_id),
  escrow_id UUID REFERENCES title_escrow_contracts(escrow_id),
  baseline_json JSONB NOT NULL,
  interval_minutes INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  until_date DATE NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_status VARCHAR(20),
  tinyfish_monitor_id VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monitor_alerts (
  alert_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES monitor_subscriptions(subscription_id),
  kind VARCHAR(40) NOT NULL,
  detail JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- ledger extensions (fields needed to recompute Hₙ) ----------
ALTER TABLE immutable_certificate_ledger
  ADD COLUMN IF NOT EXISTS document_type VARCHAR(30) NOT NULL DEFAULT 'TITLE_CLEARANCE_CERTIFICATE',
  ADD COLUMN IF NOT EXISTS property_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS evidence_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS recorded_at_iso VARCHAR(40),
  ADD COLUMN IF NOT EXISTS pdf_sha256 CHAR(64),
  ADD COLUMN IF NOT EXISTS pdf_storage_uri TEXT,
  ADD COLUMN IF NOT EXISTS signer_serial VARCHAR(80);

-- Append-only: forbid UPDATE/DELETE on the ledger at the database level.
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable_certificate_ledger is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_ledger_append_only ON immutable_certificate_ledger;
CREATE TRIGGER trg_ledger_append_only BEFORE UPDATE OR DELETE ON immutable_certificate_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TABLE IF NOT EXISTS merkle_anchors (
  anchor_id BIGSERIAL PRIMARY KEY,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  first_sequence BIGINT NOT NULL,
  last_sequence BIGINT NOT NULL,
  leaf_count INTEGER NOT NULL,
  merkle_root CHAR(64) NOT NULL,
  tsa_url TEXT,
  tsa_rfc3161_token BYTEA,
  tsa_status VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_start)
);

-- ---------- outbound webhooks to banks ----------
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  url TEXT NOT NULL,
  event VARCHAR(60) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- DPDP audit trail of API access ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor VARCHAR(120),
  tenant_id UUID,
  method VARCHAR(10) NOT NULL,
  route VARCHAR(200) NOT NULL,
  status_code INTEGER,
  ip_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Sandbox trustee bank (stands in for Castler / Cashfree Escrow / Yes Bank API) ----------
CREATE TABLE IF NOT EXISTS sandbox_bank_virtual_accounts (
  va_number VARCHAR(35) PRIMARY KEY,
  ifsc CHAR(11) NOT NULL,
  escrow_reference VARCHAR(100) NOT NULL UNIQUE,
  oracle_public_key TEXT NOT NULL,
  payee_a JSONB NOT NULL,
  payee_b JSONB NOT NULL,
  fee_account JSONB NOT NULL,
  expected_amount_inr NUMERIC(15, 2) NOT NULL,
  balance_inr NUMERIC(15, 2) NOT NULL DEFAULT 0,
  webhook_url TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sandbox_bank_transactions (
  utr VARCHAR(50) PRIMARY KEY,
  va_number VARCHAR(35) NOT NULL REFERENCES sandbox_bank_virtual_accounts(va_number),
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('CREDIT', 'PAYOUT')),
  beneficiary VARCHAR(20),
  amount_inr NUMERIC(15, 2) NOT NULL,
  mode VARCHAR(10) NOT NULL,
  counterparty JSONB,
  instruction JSONB,
  status VARCHAR(20) NOT NULL,
  failure_reason TEXT,
  idempotency_key VARCHAR(120) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sandbox_bank_nonces (
  nonce VARCHAR(80) PRIMARY KEY,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent processing of bank webhooks (retries must not double-count a deposit).
CREATE TABLE IF NOT EXISTS bank_webhook_events (
  utr VARCHAR(50) PRIMARY KEY,
  event VARCHAR(40) NOT NULL,
  escrow_id UUID,
  amount_inr NUMERIC(15, 2),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Replay-mode test hooks (dev only): extra portal rows injected for a property, e.g. to
-- demonstrate continuous monitoring catching a bridge loan taken after release.
CREATE TABLE IF NOT EXISTS replay_overlays (
  id BIGSERIAL PRIMARY KEY,
  state_code CHAR(2) NOT NULL,
  village_name VARCHAR(120) NOT NULL,
  survey_number VARCHAR(100) NOT NULL,
  agent_role VARCHAR(20) NOT NULL,
  field VARCHAR(40) NOT NULL,
  entry JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
