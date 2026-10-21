-- 001: Core schema exactly as specified in the TitleShield architecture blueprint (PDF §8).
-- Later migrations extend it; this file is kept verbatim so it can be diffed against the spec.

-- Enable extensions for UUIDv7, cryptographic hashing, and fuzzy text search
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- 1. Core Title Search Request Table
CREATE TABLE title_searches (
    search_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL, -- Retail Customer Org or B2B Bank ID (HDFC/SBI)
    tier_type VARCHAR(20) NOT NULL CHECK (tier_type IN ('RETAIL_B2C', 'BANK_B2B_API', 'ESCROW_LINKED')),
    
    -- Normalized Geographical Hierarchy
    state_code CHAR(2) NOT NULL,
    district_name VARCHAR(120) NOT NULL,
    taluk_name VARCHAR(120) NOT NULL,
    village_name VARCHAR(120) NOT NULL,
    survey_number VARCHAR(100) NOT NULL,
    sub_division_hissa VARCHAR(50),
    claimed_owner_name VARCHAR(255),
    
    -- Execution Status
    status VARCHAR(30) NOT NULL DEFAULT 'QUEUED'
        CHECK (status IN ('QUEUED', 'RUNNING_TINYFISH', 'OCR_PARSING', 'SCORING', 'COMPLETED', 'FAILED', 'MANUAL_REVIEW')),
    
    -- Strict Output Schema Fields
    has_active_mortgage BOOLEAN,
    pending_litigation_count INTEGER,
    last_owner_name VARCHAR(255),
    encumbrance_clearance_score SMALLINT CHECK (encumbrance_clearance_score BETWEEN 0 AND 100),
    
    -- Evidence & Audit
    worm_evidence_s3_uri TEXT,
    evidence_sha256_hash CHAR(64),
    certificate_pdf_s3_uri TEXT,
    
    execution_duration_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_searches_geo ON title_searches (state_code, district_name, taluk_name, village_name, survey_number);
CREATE INDEX idx_searches_tenant_created ON title_searches (tenant_id, created_at DESC);

-- 2. TinyFish Agent Execution Runs (1-to-Many per Search)
CREATE TABLE tinyfish_agent_runs (
    run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    search_id UUID NOT NULL REFERENCES title_searches(search_id) ON DELETE RESTRICT,
    portal_code VARCHAR(40) NOT NULL, -- e.g., 'BHULEKH_UP', 'ECOURTS_NJDG', 'CERSAI'
    tinyfish_session_id VARCHAR(120),
    goal_prompt_version VARCHAR(30) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('STREAMING', 'SUCCESS', 'TIMEOUT', 'CAPTCHA_BLOCKED', 'PORTAL_DOWN')),
    extracted_json JSONB,
    raw_sse_log_s3_uri TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);

-- 3. Regulated FinTech Title Escrow Contracts
CREATE TABLE title_escrow_contracts (
    escrow_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    search_id UUID UNIQUE REFERENCES title_searches(search_id),
    
    -- Parties
    buyer_user_id UUID NOT NULL,
    buyer_refund_account_no VARCHAR(35) NOT NULL,
    buyer_refund_ifsc CHAR(11) NOT NULL,
    
    seller_user_id UUID NOT NULL,
    seller_payout_account_no VARCHAR(35) NOT NULL,
    seller_payout_ifsc CHAR(11) NOT NULL,
    
    -- Financials
    property_total_value_inr NUMERIC(15, 2) NOT NULL,
    advance_deposit_amount_inr NUMERIC(15, 2) NOT NULL, -- Typically 10% of property value
    platform_escrow_fee_inr NUMERIC(15, 2) NOT NULL,    -- 0.25% fee
    
    -- Banking Partner Virtual Account Details
    partner_bank_escrow_id VARCHAR(100) NOT NULL UNIQUE,
    virtual_account_number VARCHAR(35) NOT NULL,
    virtual_account_ifsc CHAR(11) NOT NULL,
    
    -- State Machine
    escrow_state VARCHAR(40) NOT NULL DEFAULT 'AWAITING_DEPOSIT'
        CHECK (escrow_state IN (
            'AWAITING_DEPOSIT',
            'FUNDS_LOCKED',
            'VERIFICATION_IN_PROGRESS',
            'RELEASED_TO_SELLER',
            'REFUNDED_TO_BUYER',
            'DISPUTE_HOLD'
        )),
    
    bank_utr_deposit VARCHAR(50),
    bank_utr_settlement VARCHAR(50),
    tri_party_esign_doc_uri TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ
);

-- 4. Immutable Hash-Chained Audit Ledger (Tamper-Evident)
CREATE TABLE immutable_certificate_ledger (
    sequence_no BIGSERIAL PRIMARY KEY,
    certificate_id VARCHAR(64) NOT NULL UNIQUE,
    search_id UUID NOT NULL REFERENCES title_searches(search_id),
    escrow_id UUID REFERENCES title_escrow_contracts(escrow_id),
    payload_canonical_json JSONB NOT NULL,
    previous_row_hash CHAR(64) NOT NULL,
    current_row_hash CHAR(64) NOT NULL,
    tsa_rfc3161_token BYTEA,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
