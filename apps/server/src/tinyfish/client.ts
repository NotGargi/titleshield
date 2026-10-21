import crypto from "node:crypto";
import { canonicalJson } from "@titleshield/core";
import { config } from "../config.ts";
import { one, q } from "../db/pool.ts";
import { getSecret } from "../settings.ts";

/**
 * TinyFish — FREE tier only (tinyfish.ai/pricing: "Search and Fetch are free").
 *   Search: GET  https://api.search.tinyfish.ai/?query=…   (30 req/min, 500 req/hour)
 *   Fetch:  POST https://api.fetch.tinyfish.ai/ {urls}     (150 URLs/min, 1,000 URLs/day)
 * Auth: X-API-Key. The paid products (browser Agent, Browser sessions, Monitor) are not used.
 * The client keeps itself under the free limits, retries 429s politely, and caches
 * responses so repeated searches of the same property cost nothing.
 */

export type TinyFishErrorCode = "NOT_CONFIGURED" | "INVALID_KEY" | "RATE_LIMITED" | "QUOTA" | "HTTP" | "NETWORK";
export class TinyFishError extends Error {
  constructor(public code: TinyFishErrorCode, message: string, public status?: number) { super(message); }
}

export interface SearchResult { position: number; site_name: string; snippet: string; title: string; url: string; date?: string }
export interface FetchResult { url: string; final_url?: string; title?: string; description?: string; language?: string; text: string; published_date?: string }
export interface FetchError { url: string; error: string; status?: number }

// ---------- free-tier limiter ----------
const windows = { searchMin: [] as number[], searchHour: [] as number[], fetchMin: [] as number[] };
const prune = (arr: number[], ms: number) => { const cut = Date.now() - ms; while (arr.length && arr[0] < cut) arr.shift(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bumpUsage(kind: "search" | "fetch", units: number) {
  await q(`INSERT INTO tinyfish_usage (day, kind, units) VALUES (CURRENT_DATE, $1, $2)
           ON CONFLICT (day, kind) DO UPDATE SET units = tinyfish_usage.units + EXCLUDED.units`, [kind, units]).catch(() => {});
}

export async function usageToday() {
  const rows = await q("SELECT kind, units FROM tinyfish_usage WHERE day = CURRENT_DATE");
  const get = (k: string) => Number(rows.find((r) => r.kind === k)?.units ?? 0);
  return {
    search: { used: get("search"), perMinute: config.TINYFISH_SEARCH_PER_MIN, perHour: config.TINYFISH_SEARCH_PER_HOUR },
    fetch: { used: get("fetch"), perDay: config.TINYFISH_FETCH_PER_DAY, perMinute: config.TINYFISH_FETCH_PER_MIN }
  };
}

type OnWait = (ms: number) => void | Promise<void>;

async function takeSearchSlot(onWait?: OnWait) {
  prune(windows.searchHour, 3600_000);
  if (windows.searchHour.length >= config.TINYFISH_SEARCH_PER_HOUR) throw new TinyFishError("RATE_LIMITED", "Free Search limit reached for this hour (500). Try again later.");
  for (;;) {
    prune(windows.searchMin, 60_000);
    if (windows.searchMin.length < config.TINYFISH_SEARCH_PER_MIN) break;
    const ms = windows.searchMin[0] + 60_050 - Date.now();
    await onWait?.(ms);
    await sleep(ms);
  }
  windows.searchMin.push(Date.now()); windows.searchHour.push(Date.now());
}

async function takeFetchSlots(n: number, onWait?: OnWait) {
  const today = await one("SELECT units FROM tinyfish_usage WHERE day = CURRENT_DATE AND kind = 'fetch'");
  if (Number(today?.units ?? 0) + n > config.TINYFISH_FETCH_PER_DAY) throw new TinyFishError("QUOTA", `Free Fetch limit for today (${config.TINYFISH_FETCH_PER_DAY} pages) is used up. Pages will be read again tomorrow.`);
  for (;;) {
    prune(windows.fetchMin, 60_000);
    if (windows.fetchMin.length + n <= config.TINYFISH_FETCH_PER_MIN) break;
    const ms = windows.fetchMin[0] + 60_050 - Date.now();
    await onWait?.(ms);
    await sleep(ms);
  }
  for (let i = 0; i < n; i++) windows.fetchMin.push(Date.now());
}

// ---------- cache ----------
const key = (kind: string, req: object) => crypto.createHash("sha256").update(kind + canonicalJson(req)).digest("hex");
async function cacheGet<T>(kind: string, req: object): Promise<T | null> {
  const r = await one("SELECT response FROM web_cache WHERE cache_key = $1 AND created_at > NOW() - ($2 || ' hours')::interval", [key(kind, req), String(config.WEB_CACHE_HOURS)]).catch(() => null);
  return (r?.response as T) ?? null;
}
async function cachePut(kind: string, req: object, response: object) {
  await q(`INSERT INTO web_cache (cache_key, kind, request, response, created_at) VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (cache_key) DO UPDATE SET response = EXCLUDED.response, created_at = NOW()`, [key(kind, req), kind, JSON.stringify(req), JSON.stringify(response)]).catch(() => {});
}

async function apiKey() {
  const k = (await getSecret("TINYFISH_API_KEY")).value;
  if (!k) throw new TinyFishError("NOT_CONFIGURED", "No TinyFish API key. Add your free key on the Settings page.");
  return k;
}

async function errorFrom(res: Response): Promise<TinyFishError> {
  let msg = "";
  try { const j: any = await res.json(); msg = j?.error?.message ?? j?.message ?? ""; } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 403) return new TinyFishError("INVALID_KEY", `TinyFish rejected the API key${msg ? `: ${msg}` : ""}. Check it on the Settings page.`, res.status);
  if (res.status === 429) return new TinyFishError("RATE_LIMITED", `TinyFish rate limit${msg ? `: ${msg}` : ""}`, 429);
  if (res.status === 402) return new TinyFishError("QUOTA", `TinyFish free allowance used up${msg ? `: ${msg}` : ""}.`, 402);
  return new TinyFishError("HTTP", `TinyFish HTTP ${res.status}${msg ? `: ${msg}` : ""}`, res.status);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      const te = e instanceof TinyFishError ? e : new TinyFishError("NETWORK", `Could not reach TinyFish: ${(e as Error).message}`);
      const retryable = te.code === "RATE_LIMITED" && te.status === 429 || te.code === "NETWORK" || (te.code === "HTTP" && (te.status ?? 0) >= 500);
      if (!retryable || attempt >= 2) throw te;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

// ---------- Search ----------
export interface SearchParams { query: string; purpose?: string; includeDomains?: string[]; location?: string; language?: string; page?: number }

export async function tfSearch(p: SearchParams, opts: { fresh?: boolean; onWait?: OnWait } = {}): Promise<{ results: SearchResult[]; cached: boolean }> {
  const req = { query: p.query.slice(0, 2000), purpose: p.purpose?.slice(0, 2000), include_domains: p.includeDomains?.join(","), location: p.location ?? "IN", language: p.language ?? "en", page: p.page ?? 0 };
  if (!opts.fresh) {
    const hit = await cacheGet<{ results: SearchResult[] }>("search", req);
    if (hit) return { results: hit.results, cached: true };
  }
  const k = await apiKey();
  const data = await withRetry(async () => {
    await takeSearchSlot(opts.onWait);
    const url = new URL(config.TINYFISH_SEARCH_URL);
    for (const [name, v] of Object.entries(req)) if (v !== undefined && v !== "") url.searchParams.set(name, String(v));
    const res = await fetch(url, { headers: { "X-API-Key": k, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw await errorFrom(res);
    return (await res.json()) as { results?: SearchResult[] };
  });
  await bumpUsage("search", 1);
  const results = (data.results ?? []).filter((r) => r && r.url);
  await cachePut("search", req, { results });
  return { results, cached: false };
}

// ---------- Fetch ----------
export async function tfFetch(urls: string[], purpose?: string, opts: { fresh?: boolean; onWait?: OnWait } = {}): Promise<{ results: FetchResult[]; errors: FetchError[] }> {
  const unique = [...new Set(urls)].slice(0, 10);
  const results: FetchResult[] = [], errors: FetchError[] = [], todo: string[] = [];
  for (const u of unique) {
    const hit = opts.fresh ? null : await cacheGet<FetchResult | { failed: FetchError }>("fetch", { url: u });
    if (hit && "failed" in hit) errors.push(hit.failed);
    else if (hit) results.push(hit as FetchResult);
    else todo.push(u);
  }
  if (!todo.length) return { results, errors };
  const k = await apiKey();
  const data = await withRetry(async () => {
    await takeFetchSlots(todo.length, opts.onWait);
    const res = await fetch(config.TINYFISH_FETCH_URL, {
      method: "POST",
      headers: { "X-API-Key": k, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ urls: todo, format: "markdown", purpose: purpose?.slice(0, 2000), per_url_timeout_ms: 25_000, page_metadata: false }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!res.ok) throw await errorFrom(res);
    return (await res.json()) as { results?: FetchResult[]; errors?: FetchError[] };
  });
  const got = (data.results ?? []).filter((r) => r && typeof r.text === "string");
  // Failed fetches are not charged against the free quota.
  await bumpUsage("fetch", got.length);
  for (const r of got) { results.push(r); await cachePut("fetch", { url: r.url }, r); }
  // Remember pages that could not be read too, so they are not retried on every search.
  for (const er of data.errors ?? []) { errors.push(er); await cachePut("fetch", { url: er.url }, { failed: er }); }
  return { results, errors };
}

/** Real call used by "Test connection" on the Settings page. */
export async function testTinyFish() {
  const r = await tfSearch({ query: "Encumbrance Certificate online Karnataka Kaveri", includeDomains: ["gov.in"] }, { fresh: true });
  return { ok: true, results: r.results.length, sample: r.results.slice(0, 3).map((x) => ({ title: x.title, url: x.url })) };
}
