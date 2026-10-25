import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { one } from "../db/pool.ts";
import { hashPassword, verifyPassword } from "../crypto/secrets.ts";
import { HttpError, requireActor } from "../http/auth.ts";

export async function authRoutes(app: FastifyInstance) {
  const issue = (u: any) => ({
    token: app.jwt.sign({ sub: u.user_id, role: u.role }, { expiresIn: "12h" }),
    user: { id: u.user_id, email: u.email, name: u.full_name, role: u.role }
  });

  app.post("/api/v1/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const u = await one("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
    if (!u || !verifyPassword(password, u.password_hash)) throw new HttpError(401, "Email or password is incorrect");
    return issue(u);
  });

  app.post("/api/v1/auth/register", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { email, password, name } = z.object({ email: z.string().email(), password: z.string().min(8, "Use at least 8 characters"), name: z.string().min(2).max(200) }).parse(req.body);
    if (await one("SELECT 1 FROM users WHERE lower(email) = lower($1)", [email])) throw new HttpError(409, "An account with this email already exists");
    const u = await one(`INSERT INTO users (tenant_id, email, full_name, role, password_hash) VALUES ((SELECT tenant_id FROM tenants WHERE name = 'TitleShield Retail'), $1, $2, 'BUYER', $3) RETURNING *`,
      [email.toLowerCase(), name, hashPassword(password)]);
    return reply.code(201).send(issue(u));
  });

  app.get("/api/v1/auth/me", async (req) => {
    const a = requireActor(req);
    return a;
  });
}
