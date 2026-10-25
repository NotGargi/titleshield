import crypto from "node:crypto";
import { canonicalJson } from "@titleshield/core";
import { config } from "../config.ts";
import { one, q } from "../db/pool.ts";
import { getSecret } from "../settings.ts";

/**
 * TinyFish Search + Fetch only (docs.tinyfish.ai/search-api/reference, /fetch-api/reference).
 *   Search: GET  https://api.search.tinyfish.ai?query=…&include_domains=…&location=IN&language=en
 *           → { query, results[{position, site_name, title, snippet, url, date?}], total_results, page }
 *   Fetch:  POST https://api.fetch.tinyfish.ai {urls ≤10, format, purpose, per_url_timeout_ms}
 *           → { results[{url, final_url, title, description, language, text, ...}], errors[{url, error, status?}] }
 * Auth: X-API-Key. 401 bad key · 402 allowance/wallet exhausted · 429 rate limit · 503 retry later.
 * No Agent, Browser, Vault or Monitor calls exist anywhere in this project.
 * The client stays under the published limits, retries only transient errors (bounded), caches
 * responses, meters every call against the project's credit budget, and refuses unsafe URLs.
 */

export type TinyFishErrorCode = "NOT_CONFIGURED" | "INVALID_KEY" | "RATE_LIMITED" | "QUOTA" | "BUDGET" | "HTTP" | "NETWORK" | "UNSAFE_URL";
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

export async function creditsUsed() {
  const r = await one("SELECT COALESCE(SUM(units) FILTER (WHERE kind = 'search'), 0) AS s, COALESCE(SUM(units) FILTER (WHERE kind = 'fetch'), 0) AS f FROM tinyfish_usage");
  return Number(r?.s ?? 0) * config.TINYFISH_CREDITS_PER_SEARCH + Number(r?.f ?? 0) * config.TINYFISH_CREDITS_PER_FETCH;
}

async function checkBudget(cost: number) {
  const used = await creditsUsed();
  if (used + cost > config.TINYFISH_CREDIT_BUDGET) {
    throw new TinyFishError("BUDGET", `TinyFish credit budget reached (${used} of ${config.TINYFISH_CREDIT_BUDGET} used). The check is marked incomplete instead of spending more.`);
  }
}

export async function usageToday() {
  const rows = await q("SELECT kind, units FROM tinyfish_usage WHERE day = CURRENT_DATE");
  const get = (k: string) => Number(rows.find((r) => r.kind === k)?.units ?? 0);
  const used = await creditsUsed();
  return {
    search: { used: get("search"), perMinute: config.TINYFISH_SEARCH_PER_MIN, perHour: config.TINYFISH_SEARCH_PER_HOUR },
    fetch: { used: get("fetch"), perDay: config.TINYFISH_FETCH_PER_DAY, perMinute: config.TINYFISH_FETCH_PER_MIN },
    credits: { budget: config.TINYFISH_CREDIT_BUDGET, used, remaining: Math.max(0, config.TINYFISH_CREDIT_BUDGET - used), perSearch: config.TINYFISH_CREDITS_PER_SEARCH, perFetch: config.TINYFISH_CREDITS_PER_FETCH }
  };
}

// ---------- URL safety (nothing private, local or malformed is ever sent to Fetch) ----------
const PRIVATE_V4 = [/^10\./, /^127\./, /^0\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export function unsafeUrlReason(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "malformed URL"; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return `scheme ${u.protocol} not allowed`;
  if (u.username || u.password) return "credentials in URL";
  if (raw.length > 2048) return "URL too long";
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(".") || h === "localhost" || /\.(local|internal|localhost|lan|home|corp)$/.test(h)) return "local hostname";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return PRIVATE_V4.some((r) => r.test(h)) ? "private IP address" : "raw IP address";
  if (h.includes(":")) return "raw IPv6 address";
  if (h === "metadata.google.internal" || h.startsWith("169.254.")) return "cloud metadata endpoint";
  return null;
}

/** Normalised form used for de-duplication (no fragment, no trailing slash, lower-case host). */
export function normaliseUrl(raw: string) {
  try { const u = new URL(raw); u.hash = ""; u.hostname = u.hostname.toLowerCase(); return u.toString().replace(/\/$/, ""); } catch { return raw; }
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
  if (res.status === 401) return new TinyFishError("INVALID_KEY", `TinyFish rejected the API key${msg ? `: ${msg}` : ""}. Check it on the Settings page.`, res.status);
  if (res.status === 403) return new TinyFishError("HTTP", `TinyFish refused the request (403)${msg ? `: ${msg}` : ""}`, 403);
  if (res.status === 429) return new TinyFishError("RATE_LIMITED", `TinyFish rate limit${msg ? `: ${msg}` : ""}`, 429);
  if (res.status === 402) return new TinyFishError("QUOTA", `TinyFish free allowance used up and no wallet balance (402${msg ? `: ${msg}` : ""}).`, 402);
  if (res.status === 400) return new TinyFishError("HTTP", `TinyFish rejected the request parameters (400)${msg ? `: ${msg}` : ""}`, 400);
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

export async function tfSearch(p: SearchParams, opts: { fresh?: boolean; onWait?: OnWait } = {}): Promise<{ results: SearchResult[]; cached: boolean; raw?: unknown }> {
  const req = { query: p.query.slice(0, 2000), purpose: p.purpose?.slice(0, 2000), include_domains: p.includeDomains?.join(","), location: p.location ?? "IN", language: p.language ?? "en", page: p.page ?? 0 };
  if (!opts.fresh) {
    const hit = await cacheGet<{ results: SearchResult[] }>("search", req);
    if (hit) return { results: hit.results, cached: true };
  }
  const k = await apiKey();
  await checkBudget(config.TINYFISH_CREDITS_PER_SEARCH);
  const data = await withRetry(async () => {
    await takeSearchSlot(opts.onWait);
    const url = new URL(config.TINYFISH_SEARCH_URL);
    for (const [name, v] of Object.entries(req)) if (v !== undefined && v !== "") url.searchParams.set(name, String(v));
    const res = await fetch(url, { headers: { "X-API-Key": k, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw await errorFrom(res);
    const j = await res.json().catch(() => null);
    if (!j || typeof j !== "object" || !Array.isArray((j as any).results)) throw new TinyFishError("HTTP", "TinyFish Search returned an unexpected response (no results array)");
    return j as { results?: SearchResult[]; total_results?: number };
  });
  await bumpUsage("search", 1);
  const results = (data.results ?? []).filter((r) => r && typeof r.url === "string" && r.url);
  await cachePut("search", req, { results });
  return { results, cached: false, raw: { total_results: data.total_results, count: results.length } };
}

// ---------- Fetch ----------
export async function tfFetch(urls: string[], purpose?: string, opts: { fresh?: boolean; onWait?: OnWait } = {}): Promise<{ results: FetchResult[]; errors: FetchError[] }> {
  const unique = [...new Set(urls)].slice(0, 10);
  const results: FetchResult[] = [], errors: FetchError[] = [], todo: string[] = [];
  for (const u of unique) {
    const unsafe = unsafeUrlReason(u);
    if (unsafe) { errors.push({ url: u, error: `unsafe_url: ${unsafe}` }); continue; }
    const hit = opts.fresh ? null : await cacheGet<FetchResult | { failed: FetchError }>("fetch", { url: u });
    if (hit && "failed" in hit) errors.push(hit.failed);
    else if (hit) results.push(hit as FetchResult);
    else todo.push(u);
  }
  if (!todo.length) return { results, errors };
  const k = await apiKey();
  await checkBudget(todo.length * config.TINYFISH_CREDITS_PER_FETCH);
  const data = await withRetry(async () => {
    await takeFetchSlots(todo.length, opts.onWait);
    // Only documented request fields (docs.tinyfish.ai/fetch-api/reference).
    const body: Record<string, unknown> = { urls: todo, format: "markdown", per_url_timeout_ms: 30_000 };
    if (purpose?.trim()) body.purpose = purpose.trim().slice(0, 2000);
    const res = await fetch(config.TINYFISH_FETCH_URL, {
      method: "POST",
      headers: { "X-API-Key": k, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000)   // docs: 110 s per URL, 120 s per batch
    });
    if (!res.ok) throw await errorFrom(res);
    const j = await res.json().catch(() => null);
    if (!j || typeof j !== "object" || !Array.isArray((j as any).results)) throw new TinyFishError("HTTP", "TinyFish Fetch returned an unexpected response (no results array)");
    return j as { results?: FetchResult[]; errors?: FetchError[] };
  });
  // Empty pages count as failures, not as evidence.
  const got = (data.results ?? []).filter((r) => r && typeof r.text === "string" && r.text.trim().length > 0);
  for (const r of data.results ?? []) if (r && !got.includes(r)) errors.push({ url: r.url, error: "empty_content" });
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

/**
 * Step-by-step diagnosis (blueprint Phase 1): Search alone → Fetch of a known public page →
 * a Search result passed into Fetch. Each step reports what TinyFish actually returned.
 */
export async function diagnoseTinyFish() {
  const steps: Array<{ step: string; ok: boolean; ms: number; detail: string; sample?: unknown }> = [];
  const time = async <T>(step: string, fn: () => Promise<T>, describe: (r: T) => { ok: boolean; detail: string; sample?: unknown }) => {
    const t = Date.now();
    try { const r = await fn(); steps.push({ step, ms: Date.now() - t, ...describe(r) }); return r; }
    catch (e) { const te = e as TinyFishError; steps.push({ step, ok: false, ms: Date.now() - t, detail: `${te.code ?? "ERROR"}: ${te.message}` }); return null; }
  };
  const search = await time("1. Search (GET api.search.tinyfish.ai)", () => tfSearch({ query: "IGR Maharashtra Index II property registration search", includeDomains: ["gov.in"], purpose: "Connectivity check for a property title search app" }, { fresh: true }),
    (r) => ({ ok: r.results.length > 0, detail: `${r.results.length} results (fields: ${r.results[0] ? Object.keys(r.results[0]).join(", ") : "none"})`, sample: r.results.slice(0, 3).map((x) => ({ title: x.title, url: x.url })) }));
  await time("2. Fetch a known public page (POST api.fetch.tinyfish.ai)", () => tfFetch(["https://example.com/"], "Connectivity check", { fresh: true }),
    (r) => ({ ok: r.results.length > 0, detail: r.results.length ? `read ${r.results[0].text.length} characters, title "${r.results[0].title ?? ""}"` : `failed: ${r.errors.map((e) => `${e.error}${e.status ? ` ${e.status}` : ""}`).join(", ")}` }));
  const first = search?.results.find((x) => !unsafeUrlReason(x.url));
  if (first) {
    await time("3. Pass a Search result into Fetch", () => tfFetch([first.url], "Check that search results can be read", { fresh: true }),
      (r) => ({ ok: r.results.length > 0, detail: r.results.length ? `${first.url} → ${r.results[0].text.length} characters` : `${first.url} could not be read: ${r.errors.map((e) => e.error).join(", ")} (some government portals block automated reading)` }));
  } else steps.push({ step: "3. Pass a Search result into Fetch", ok: false, ms: 0, detail: "skipped: no usable search result" });
  return { ok: steps.every((s) => s.ok), steps, usage: await usageToday() };
}
