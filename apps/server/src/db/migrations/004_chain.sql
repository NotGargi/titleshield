-- 004: Smart-contract escrow. Each escrow is mirrored by a TitleEscrow contract record;
-- every transaction the platform sends is kept here for the in-app block explorer.

CREATE TABLE IF NOT EXISTS chain_contracts (
  chain_key   TEXT NOT NULL,               -- "<chainId>:<genesis block hash>" (changes if a local chain is reset)
  name        TEXT NOT NULL,               -- TitleShieldINR | TitleEscrow
  address     CHAR(42) NOT NULL,
  deploy_tx   CHAR(66),
  deploy_block BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_key, name)
);

CREATE TABLE IF NOT EXISTS chain_transactions (
  tx_hash      CHAR(66) PRIMARY KEY,
  chain_key    TEXT NOT NULL,
  escrow_id    UUID,
  search_id    UUID,
  label        TEXT NOT NULL,
  contract     TEXT,
  method       TEXT,
  from_addr    CHAR(42),
  to_addr      CHAR(42),
  block_number BIGINT,
  gas_used     BIGINT,
  status       SMALLINT,
  args         JSONB,
  events       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chain_tx_escrow ON chain_transactions (escrow_id, created_at);
CREATE INDEX IF NOT EXISTS chain_tx_recent ON chain_transactions (created_at DESC);

ALTER TABLE title_escrow_contracts
  ADD COLUMN IF NOT EXISTS chain_key TEXT,
  ADD COLUMN IF NOT EXISTS chain_escrow_id CHAR(66),
  ADD COLUMN IF NOT EXISTS buyer_wallet CHAR(42),
  ADD COLUMN IF NOT EXISTS seller_wallet CHAR(42);

ALTER TABLE tinyfish_agent_runs ALTER COLUMN mode TYPE VARCHAR(12);
