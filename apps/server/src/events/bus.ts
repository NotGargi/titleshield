import { EventEmitter } from "node:events";
import pg from "pg";
import { config } from "../config.ts";
import { one, q } from "../db/pool.ts";

/**
 * Search event bus. Every event is persisted to search_events (so a client that
 * connects late can replay the run) and fanned out with Postgres LISTEN/NOTIFY,
 * so events published by a Temporal worker process reach the API's SSE streams.
 */

export interface SearchEvent { id: number; searchId: string; event: string; data: any; at: string }

const local = new EventEmitter();
local.setMaxListeners(0);
let listener: pg.Client | null = null;
let listening: Promise<void> | null = null;

async function ensureListener() {
  if (listening) return listening;
  listening = (async () => {
    listener = new pg.Client({ connectionString: config.DATABASE_URL });
    await listener.connect();
    // Notifications are handled one at a time so subscribers always see events in order.
    let chain = Promise.resolve();
    listener.on("notification", (msg) => {
      chain = chain.then(async () => {
        try {
          const { id } = JSON.parse(msg.payload ?? "{}");
          const row = await one("SELECT event_id, search_id, event, data, created_at FROM search_events WHERE event_id = $1", [id]);
          if (row) local.emit(row.search_id, toEvent(row));
        } catch { /* ignore malformed notifications */ }
      });
    });
    listener.on("error", () => { listening = null; listener = null; });
    await listener.query("LISTEN search_events");
  })();
  return listening;
}

const toEvent = (r: any): SearchEvent => ({ id: Number(r.event_id), searchId: r.search_id, event: r.event, data: r.data, at: new Date(r.created_at).toISOString() });

export async function publish(searchId: string, event: string, data: Record<string, unknown>) {
  const row = await one<{ event_id: number }>(
    "INSERT INTO search_events (search_id, event, data) VALUES ($1, $2, $3) RETURNING event_id",
    [searchId, event, JSON.stringify(data)]
  );
  await q("SELECT pg_notify('search_events', $1)", [JSON.stringify({ id: row!.event_id })]);
}

export async function history(searchId: string, afterId = 0): Promise<SearchEvent[]> {
  const rows = await q("SELECT event_id, search_id, event, data, created_at FROM search_events WHERE search_id = $1 AND event_id > $2 ORDER BY event_id", [searchId, afterId]);
  return rows.map(toEvent);
}

export async function subscribe(searchId: string, fn: (e: SearchEvent) => void): Promise<() => void> {
  await ensureListener();
  local.on(searchId, fn);
  return () => local.off(searchId, fn);
}

export async function closeBus() {
  await listener?.end().catch(() => {});
  listener = null; listening = null;
}
