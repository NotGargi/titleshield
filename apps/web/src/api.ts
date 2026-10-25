/** Thin client for the TitleShield API. Session token lives in localStorage. */

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

export interface User { id: string; email: string; name: string; role: string }

export const session = {
  get token(): string | null { try { return localStorage.getItem("ts.token"); } catch { return null; } },
  get user(): User | null { try { return JSON.parse(localStorage.getItem("ts.user") ?? "null"); } catch { return null; } },
  set(token: string, user: User) { try { localStorage.setItem("ts.token", token); localStorage.setItem("ts.user", JSON.stringify(user)); } catch { /* storage blocked */ } window.dispatchEvent(new Event("ts-session")); },
  clear() { try { localStorage.removeItem("ts.token"); localStorage.removeItem("ts.user"); } catch { /* */ } window.dispatchEvent(new Event("ts-session")); }
};

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method: opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET"),
    headers,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined)
  });
  const text = await r.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!r.ok) {
    if (r.status === 401 && session.token) session.clear();
    throw new ApiError(r.status, (data && data.error) || `Request failed (${r.status})`);
  }
  return data as T;
}

/** Live event stream of a search (SSE). EventSource can't send headers, so the token rides in the query. */
export function streamEvents(searchId: string, onEvent: (name: string, data: any, id: number) => void): () => void {
  const qs = session.token ? `?access_token=${encodeURIComponent(session.token)}` : "";
  const es = new EventSource(`${BASE}/api/v1/title-search/${searchId}/events${qs}`);
  const names = ["agent_spawned", "location_resolved", "tinyfish_started", "tinyfish_progress", "tinyfish_streaming_url", "tinyfish_agent_completed", "portal_retry_scheduled",
    "document_uploaded", "ocr_completed", "title_scored", "advocate_review_opened", "advocate_decision", "title_clearance_result", "search_failed",
    "escrow_state", "escrow_deposit", "escrow_settled", "escrow_payout_confirmed", "chain_tx", "monitor_started", "monitor_check_started", "monitor_check_completed", "monitor_alert"];
  for (const n of names) es.addEventListener(n, (e) => onEvent(n, JSON.parse((e as MessageEvent).data), Number((e as MessageEvent).lastEventId)));
  es.addEventListener("error", () => { if (es.readyState === EventSource.CLOSED) es.close(); });
  return () => es.close();
}

export const inr = (n: number | null | undefined) => n == null ? "—" : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");
export const fileUrl = (path: string) => `${BASE}${path}${path.includes("?") ? "&" : "?"}${session.token ? `access_token=${encodeURIComponent(session.token)}` : ""}`;
export const isIndic = (s: string) => /[ऀ-෿]/.test(s ?? "");
