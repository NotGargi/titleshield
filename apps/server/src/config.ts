import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(SERVER_ROOT, "../..");

const bool = z.preprocess((v) => (typeof v === "string" ? ["1", "true", "yes", "on"].includes(v.toLowerCase()) : v), z.boolean());

const Env = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8080),
  PUBLIC_BASE_URL: z.string().default("http://localhost:8080"),
  WEB_BASE_URL: z.string().default("http://localhost:5173"),
  // No user or password: Postgres.app / Homebrew Postgres log in as your Mac user.
  DATABASE_URL: z.string().default("postgres://localhost:5432/titleshield"),
  JWT_SECRET: z.string().min(16).default("dev-only-change-me-please-32-chars!!"),
  FIELD_ENCRYPTION_KEY: z.string().default(""),

  // ---- TinyFish (free tier only: Search + Fetch) ----
  TINYFISH_API_KEY: z.string().default(""),
  TINYFISH_SEARCH_URL: z.string().default("https://api.search.tinyfish.ai/"),
  TINYFISH_FETCH_URL: z.string().default("https://api.fetch.tinyfish.ai/"),
  // Published free-tier limits (tinyfish.ai/pricing). The client never exceeds them.
  TINYFISH_SEARCH_PER_MIN: z.coerce.number().default(30),
  TINYFISH_SEARCH_PER_HOUR: z.coerce.number().default(500),
  TINYFISH_FETCH_PER_MIN: z.coerce.number().default(150),
  TINYFISH_FETCH_PER_DAY: z.coerce.number().default(1000),
  WEB_CACHE_HOURS: z.coerce.number().default(12),
  PAGES_PER_AGENT: z.coerce.number().default(6),

  // ---- Free location services ----
  NOMINATIM_URL: z.string().default("https://nominatim.openstreetmap.org"),
  PHOTON_URL: z.string().default("https://photon.komoot.io"),
  PINCODE_URL: z.string().default("https://api.postalpincode.in"),
  GEO_USER_AGENT: z.string().default("TitleShield-Prototype/1.1 (property title search prototype)"),

  // ---- Document reading (Gemini free tier, optional) ----
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_BASE_URL: z.string().default(""),

  // ---- Blockchain escrow (TitleEscrow smart contract) ----
  // embedded: a local Ethereum chain starts inside the API (JSON-RPC on CHAIN_PORT), state kept in CHAIN_DIR
  // rpc:      use CHAIN_RPC_URL (e.g. a testnet) with CHAIN_TRUSTEE_KEY / CHAIN_ORACLE_KEY (funded with gas)
  // off:      no smart contract
  CHAIN_MODE: z.enum(["embedded", "rpc", "off"]).default("embedded"),
  CHAIN_RPC_URL: z.string().default(""),
  CHAIN_HOST: z.string().default("127.0.0.1"),
  CHAIN_PORT: z.coerce.number().default(8545),
  CHAIN_ID: z.coerce.number().default(1337),
  CHAIN_NAME: z.string().default("TitleShield Chain"),
  CHAIN_DIR: z.string().default(path.join(REPO_ROOT, "data/chain")),
  CHAIN_TRUSTEE_KEY: z.string().default(""),
  CHAIN_ORACLE_KEY: z.string().default(""),
  CHAIN_FEE_WALLET: z.string().default(""),
  CHAIN_EXPLORER_URL: z.string().default(""),
  ESCROW_DEADLINE_DAYS: z.coerce.number().default(45),

  // Recorded TinyFish runs for the walkthrough properties in demo/ (see README); every other address runs live.
  DEMO_PROPERTIES: bool.default(true),

  // ---- Orchestration ----
  WORKFLOW_ENGINE: z.enum(["inline", "temporal"]).default("inline"),
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("titleshield"),
  MONITOR_INTERVAL_MINUTES: z.coerce.number().default(1440),

  // ---- Evidence & trust ----
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().default(path.join(REPO_ROOT, "data/worm")),
  S3_BUCKET: z.string().default("titleshield-evidence"),
  S3_REGION: z.string().default("ap-south-1"),
  S3_ENDPOINT: z.string().default(""),
  S3_FORCE_PATH_STYLE: bool.default(false),
  WORM_RETENTION_YEARS: z.coerce.number().default(15),
  PKI_DIR: z.string().default(path.join(REPO_ROOT, "data/pki")),
  SIGNER_P12_PASSWORD: z.string().default("titleshield-dev"),
  TSA_URL: z.string().default("https://freetsa.org/tsr"),
  TSA_ENABLED: bool.default(true),

  // ---- Banking (sandbox) ----
  BANK_WEBHOOK_SECRET: z.string().default("dev-bank-webhook-secret"),
  PLATFORM_FEE_BPS: z.coerce.number().default(25),
  ESIGN_PROVIDER: z.enum(["sandbox"]).default("sandbox"),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().default(120),
  TRUST_GATEWAY_MTLS_HEADER: z.string().default("")
});

export const config = Env.parse(process.env);
export type Config = typeof config;
