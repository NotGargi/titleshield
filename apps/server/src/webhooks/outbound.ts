import { one, q } from "../db/pool.ts";
import { hmacSha256 } from "../crypto/secrets.ts";
import { config } from "../config.ts";

/**
 * Outbound webhooks to bank tenants (PDF §10.3: B2B callers get 202 and the signed
 * result is pushed when ready). Body is signed with HMAC-SHA256 in X-TitleShield-Signature.
 */

export async function deliverTenantWebhook(searchId: string, event: string, payload: object) {
  const t = await one(`SELECT t.tenant_id, t.webhook_url, t.webhook_secret FROM title_searches s JOIN tenants t USING (tenant_id) WHERE s.search_id = $1 AND t.kind = 'BANK'`, [searchId]);
  if (!t?.webhook_url) return;
  const d = await one("INSERT INTO webhook_deliveries (tenant_id, url, event, payload) VALUES ($1,$2,$3,$4) RETURNING delivery_id", [t.tenant_id, t.webhook_url, event, JSON.stringify(payload)]);
  void attempt(d!.delivery_id);
}

async function attempt(deliveryId: string) {
  for (let i = 0; i < 5; i++) {
    const d = await one("SELECT w.*, t.webhook_secret FROM webhook_deliveries w JOIN tenants t USING (tenant_id) WHERE delivery_id = $1", [deliveryId]);
    if (!d || d.status === "DELIVERED") return;
    const body = JSON.stringify({ event: d.event, deliveryId, data: d.payload, sentAt: new Date().toISOString() });
    try {
      const url = d.url.startsWith("/") ? `${config.PUBLIC_BASE_URL}${d.url}` : d.url;   // relative = this deployment (demo sink)
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-TitleShield-Event": d.event, "X-TitleShield-Signature": hmacSha256(d.webhook_secret ?? "", body) }, body, signal: AbortSignal.timeout(10000) });
      if (r.ok) { await q("UPDATE webhook_deliveries SET status = 'DELIVERED', attempts = attempts + 1 WHERE delivery_id = $1", [deliveryId]); return; }
      await q("UPDATE webhook_deliveries SET attempts = attempts + 1, last_error = $2 WHERE delivery_id = $1", [deliveryId, `HTTP ${r.status}`]);
    } catch (e) {
      await q("UPDATE webhook_deliveries SET attempts = attempts + 1, last_error = $2 WHERE delivery_id = $1", [deliveryId, (e as Error).message]);
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
  }
  await q("UPDATE webhook_deliveries SET status = 'FAILED' WHERE delivery_id = $1", [deliveryId]);
}
