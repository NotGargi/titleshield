import { config } from "./config.ts";
import { one, q } from "./db/pool.ts";
import { decryptField, encryptField } from "./crypto/secrets.ts";

/**
 * Runtime secrets: a key saved on the Settings page wins over the .env value,
 * so the app can be set up from the browser without editing files.
 */

export type SecretName = "TINYFISH_API_KEY" | "GEMINI_API_KEY";

const cache = new Map<SecretName, { value: string; source: "app" | "env" | "none"; at: number }>();

export async function getSecret(name: SecretName): Promise<{ value: string; source: "app" | "env" | "none" }> {
  const c = cache.get(name);
  if (c && Date.now() - c.at < 30_000) return c;
  let value = "", source: "app" | "env" | "none" = "none";
  try {
    const row = await one("SELECT value_enc FROM app_settings WHERE key = $1", [name]);
    if (row) { value = decryptField(row.value_enc); source = "app"; }
  } catch { /* table missing during first migration, or key rotated */ }
  if (!value && config[name]) { value = config[name]; source = "env"; }
  const r = { value, source, at: Date.now() };
  cache.set(name, r);
  return r;
}

export async function setSecret(name: SecretName, value: string, userId: string | null) {
  cache.delete(name);
  if (!value) {
    await q("DELETE FROM app_settings WHERE key = $1", [name]);
    return;
  }
  await q(`INSERT INTO app_settings (key, value_enc, updated_by, updated_at) VALUES ($1,$2,$3,NOW())
           ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [name, encryptField(value), userId]);
}

export const mask = (v: string) => (v ? `••••${v.slice(-4)}` : "");
