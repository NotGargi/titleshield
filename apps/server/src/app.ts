import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { config, REPO_ROOT } from "./config.ts";
import { q } from "./db/pool.ts";
import { sha256 } from "./crypto/secrets.ts";
import { resolveActor } from "./http/auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { searchRoutes } from "./routes/search.ts";
import { escrowRoutes } from "./routes/escrow.ts";
import { trustRoutes } from "./routes/trust.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { chainRoutes } from "./routes/chain.ts";

/** API gateway & edge layer (PDF §2): rate limiting, auth, idempotency, DPDP audit. */
export async function buildApp() {
  const app = Fastify({
    logger: { level: config.NODE_ENV === "test" ? "warn" : "info", redact: ["req.headers.authorization", "req.headers[\"x-api-key\"]"] },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true
  });

  // Keep the raw JSON body so webhook signatures can be verified byte-for-byte.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as any).rawBody = body;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { (e as any).statusCode = 400; done(e as Error, undefined); }
  });

  await app.register(cors, { origin: true, credentials: true, exposedHeaders: ["Content-Disposition"] });
  await app.register(jwt, { secret: config.JWT_SECRET });
  await app.register(multipart);
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (req) => (req.headers["x-api-key"] as string) ? `key:${sha256(req.headers["x-api-key"] as string).slice(0, 16)}` : req.ip,
    allowList: (req) => req.url.startsWith("/api/v1/webhooks/") || req.url.includes("/events")
  });

  app.decorateRequest("actor", null);
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    req.actor = await resolveActor(req);
  });

  // DPDP audit trail of every API access (PDF §12)
  app.addHook("onResponse", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.method === "OPTIONS") return;
    q("INSERT INTO audit_log (actor, tenant_id, method, route, status_code, ip_hash) VALUES ($1,$2,$3,$4,$5,$6)",
      [req.actor ? `${req.actor.kind}:${req.actor.userId ?? req.actor.name}` : "anonymous", req.actor?.tenantId ?? null, req.method,
       (req.routeOptions?.url ?? req.url).slice(0, 200), reply.statusCode, sha256(`${req.ip}:${config.JWT_SECRET}`)]).catch(() => {});
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return reply.code(400).send({ error: `${i.path.join(".") || "body"}: ${i.message}`, issues: err.issues });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 && config.NODE_ENV === "production" ? "Something went wrong. Try again." : err.message });
  });

  app.get("/api/v1/health", async () => {
    await q("SELECT 1");
    return { ok: true, time: new Date().toISOString() };
  });

  await app.register(authRoutes);
  await app.register(searchRoutes);
  await app.register(escrowRoutes);
  await app.register(trustRoutes);
  await app.register(settingsRoutes);
  await app.register(chainRoutes);

  // Serve the built web app (production / docker) with SPA fallback.
  const web = path.join(REPO_ROOT, "apps/web/dist");
  if (fs.existsSync(path.join(web, "index.html"))) {
    await app.register(fastifyStatic, { root: web });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  }
  return app;
}
