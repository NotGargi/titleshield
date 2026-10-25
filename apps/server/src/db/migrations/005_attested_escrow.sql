-- 005: Attestation-verified smart-contract escrow (buyer deposits test tokens; oracle-signed verdicts)
-- and TinyFish INCOMPLETE status. Existing rows are kept; new columns are nullable.

CREATE TABLE IF NOT EXISTS verification_attestations (
  attestation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id   UUID NOT NULL,
  search_id   UUID NOT NULL,
  kind        VARCHAR(16) NOT NULL DEFAULT 'VERDICT',   -- VERDICT | SECURITY_TEST
  outcome     SMALLINT NOT NULL,                        -- 1 verified clean, 2 qualifying defect, 3 inconclusive
  payload     JSONB NOT NULL,                           -- the EIP-712 message that was signed
  signature   TEXT NOT NULL,
  signer      CHAR(42) NOT NULL,
  status      VARCHAR(12) NOT NULL DEFAULT 'PENDING',   -- PENDING | ACCEPTED | REJECTED
  tx_hash     CHAR(66),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attestations_escrow ON verification_attestations (escrow_id, created_at);

ALTER TABLE title_escrow_contracts ADD COLUMN IF NOT EXISTS funding_rail VARCHAR(8);   -- CHAIN | BANK

ALTER TABLE tinyfish_agent_runs DROP CONSTRAINT IF EXISTS tinyfish_agent_runs_status_check;
ALTER TABLE tinyfish_agent_runs ADD CONSTRAINT tinyfish_agent_runs_status_check
  CHECK (status IN ('STREAMING', 'SUCCESS', 'TIMEOUT', 'CAPTCHA_BLOCKED', 'PORTAL_DOWN', 'NO_RECORD', 'FAILED', 'NOT_CONFIGURED', 'RATE_LIMITED', 'INCOMPLETE'));
