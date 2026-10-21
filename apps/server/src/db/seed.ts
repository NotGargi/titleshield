import { one, q } from "./pool.ts";
import { hashPassword, sha256 } from "../crypto/secrets.ts";
import { config } from "../config.ts";

/** Demo tenants, users and a bank API key. Idempotent; skipped in production. */
export const DEMO = {
  password: "demo1234",
  bankApiKey: "ts_test_demobank_7f3a9c2e41d84b6f",
  users: [
    { email: "buyer@demo.in", name: "Ananya Rao", role: "BUYER", tenant: "retail" },
    { email: "seller@demo.in", name: "Venkatesh Murthy", role: "SELLER", tenant: "retail" },
    { email: "advocate@demo.in", name: "Adv. Meera Iyer", role: "ADVOCATE", tenant: "platform" },
    { email: "bank@demo.in", name: "Rohit Khanna (Credit Ops)", role: "BANK_OFFICER", tenant: "bank" },
    { email: "admin@demo.in", name: "Platform Admin", role: "ADMIN", tenant: "platform" }
  ]
} as const;

export async function seed(log = console.log) {
  if (config.NODE_ENV === "production" && !process.env.SEED_DEMO) return;
  const existing = await one("SELECT tenant_id FROM tenants WHERE name = 'TitleShield Retail'");
  if (existing) return;

  const [retail] = await q("INSERT INTO tenants (name, kind) VALUES ('TitleShield Retail', 'RETAIL') RETURNING tenant_id");
  const [platform] = await q("INSERT INTO tenants (name, kind) VALUES ('TitleShield Platform', 'PLATFORM') RETURNING tenant_id");
  const [bank] = await q(
    "INSERT INTO tenants (name, kind, webhook_url, webhook_secret) VALUES ('Demo Housing Finance (sandbox)', 'BANK', $1, $2) RETURNING tenant_id",
    ["/api/v1/dev/webhook-sink", "demo-bank-webhook-secret"]
  );
  const tenantIds = { retail: retail.tenant_id, platform: platform.tenant_id, bank: bank.tenant_id } as const;
  for (const u of DEMO.users) {
    await q("INSERT INTO users (tenant_id, email, full_name, role, password_hash) VALUES ($1,$2,$3,$4,$5)",
      [tenantIds[u.tenant], u.email, u.name, u.role, hashPassword(DEMO.password)]);
  }
  await q("INSERT INTO api_keys (tenant_id, label, key_prefix, key_hash) VALUES ($1, 'Demo bank sandbox key', $2, $3)",
    [bank.tenant_id, DEMO.bankApiKey.slice(0, 12), sha256(DEMO.bankApiKey)]);
  log(`seeded demo tenants/users (password "${DEMO.password}") and bank API key ${DEMO.bankApiKey}`);
}
