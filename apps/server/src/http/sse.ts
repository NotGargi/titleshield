import type { FastifyReply, FastifyRequest } from "fastify";
import { history, subscribe, type SearchEvent } from "../events/bus.ts";

const TERMINAL = new Set(["title_clearance_result", "search_failed"]);

/**
 * Stream a search's events as text/event-stream: replay what already happened
 * (from Last-Event-ID / ?after=), then follow live until a terminal event.
 */
export async function streamSearch(req: FastifyRequest, reply: FastifyReply, searchId: string, opts: { closeOnReview?: boolean; preamble?: Record<string, unknown> } = {}) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": (req.headers.origin as string) ?? "*"
  });
  let lastId = Number(req.headers["last-event-id"] ?? (req.query as any)?.after ?? 0) || 0;
  const resumeFrom = lastId;
  let closed = false;
  const sent = new Set<number>();
  const write = (e: SearchEvent) => {
    // De-duplicate by id rather than "newer than last": a live event may overtake an older one.
    if (closed || e.id <= resumeFrom || sent.has(e.id)) return;
    sent.add(e.id);
    lastId = Math.max(lastId, e.id);
    res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify({ ...e.data, at: e.at })}\n\n`);
    if (TERMINAL.has(e.event) || (opts.closeOnReview && e.event === "advocate_review_opened")) finish();
  };
  const heartbeat = setInterval(() => !closed && res.write(`: heartbeat\n\n`), 15000);
  let unsubscribe: () => void = () => {};
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };
  req.raw.on("close", finish);
  if (opts.preamble) res.write(`event: accepted\ndata: ${JSON.stringify(opts.preamble)}\n\n`);
  const buffered: SearchEvent[] = [];
  let replaying = true;
  unsubscribe = await subscribe(searchId, (e) => (replaying ? buffered.push(e) : write(e)));
  for (const e of await history(searchId, lastId)) write(e);
  replaying = false;
  for (const e of buffered.sort((a, b) => a.id - b.id)) write(e);
}
