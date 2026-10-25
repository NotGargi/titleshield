import type { FastifyReply, FastifyRequest } from "fastify";
import { one } from "../db/pool.ts";
import { sha256 } from "../crypto/secrets.ts";
import { config } from "../config.ts";

/**
 * Two authentication paths (PDF §9.1):
 *  - Retail / advocates: Bearer JWT.
 *  - Bank B2B tier: X-API-Key (+ mTLS terminated at the gateway, which forwards a verified header).
 */

export interface Actor {
  kind: "user" | "apikey";
  userId: string | null;
  tenantId: string;
  tenantKind: "RETAIL" | "BANK" | "PLATFORM";
  role: "BUYER" | "SELLER" | "ADVOCATE" | "BANK_OFFICER" | "ADMIN" | "BANK_API";
  name: string;
}

declare module "fastify" {
  interface FastifyRequest { actor: Actor | null }
}

export class HttpError extends Error { constructor(public statusCode: number, msg: string) { super(msg); } }

export async function resolveActor(req: FastifyRequest): Promise<Actor | null> {
  const key = req.headers["x-api-key"];
  if (typeof key === "string" && key) {
    if (config.TRUST_GATEWAY_MTLS_HEADER && req.headers[config.TRUST_GATEWAY_MTLS_HEADER.toLowerCase()] !== "SUCCESS") {
      throw new HttpError(401, "Client certificate required for API-key access");
    }
    const k = await one(`SELECT k.tenant_id, t.kind, t.name FROM api_keys k JOIN tenants t USING (tenant_id) WHERE k.key_hash = $1 AND NOT k.revoked`, [sha256(key)]);
    if (!k) throw new HttpError(401, "Invalid API key");
    return { kind: "apikey", userId: null, tenantId: k.tenant_id, tenantKind: k.kind, role: "BANK_API", name: k.name };
  }
  const auth = req.headers.authorization;
  let token: string | undefined;
  if (auth?.startsWith("Bearer ")) token = auth.slice(7);
  else if (typeof (req.query as any)?.access_token === "string") token = (req.query as any).access_token; // EventSource cannot set headers
  if (!token) return null;
  try {
    const p = req.server.jwt.verify<{ sub: string }>(token);
    const u = await one(`SELECT u.user_id, u.tenant_id, u.role, u.full_name, t.kind FROM users u JOIN tenants t USING (tenant_id) WHERE u.user_id = $1`, [p.sub]);
    if (!u) return null;
    return { kind: "user", userId: u.user_id, tenantId: u.tenant_id, tenantKind: u.kind, role: u.role, name: u.full_name };
  } catch {
    throw new HttpError(401, "Session expired. Sign in again.");
  }
}

export function requireActor(req: FastifyRequest, roles?: Actor["role"][]): Actor {
  if (!req.actor) throw new HttpError(401, "Sign in or provide an API key");
  if (roles && !roles.includes(req.actor.role)) throw new HttpError(403, `This action needs one of: ${roles.join(", ")}`);
  return req.actor;
}

export function canSeeSearch(actor: Actor | null, s: { tenant_id: string; created_by: string | null }) {
  if (!actor) return false;
  if (actor.role === "ADMIN" || actor.role === "ADVOCATE") return true;
  if (actor.kind === "apikey") return actor.tenantId === s.tenant_id;
  if (actor.role === "BANK_OFFICER") return actor.tenantId === s.tenant_id;
  return s.created_by === actor.userId;
}

export function sendError(reply: FastifyReply, e: any) {
  const status = e.statusCode ?? 500;
  if (status >= 500) reply.log.error(e);
  return reply.code(status).send({ error: status >= 500 && config.NODE_ENV === "production" ? "Internal error" : e.message });
}
