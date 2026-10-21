import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { one, q } from "../db/pool.ts";
import { HttpError, canSeeSearch, requireActor } from "../http/auth.ts";
import * as escrow from "../escrow/service.ts";
import { statement } from "../escrow/sandboxBank.ts";
import { getObject } from "../storage/worm.ts";
import { startTitleSearch } from "../workflows/engine.ts";
import { escrowOnChain } from "../chain/escrowChain.ts";

const Party = z.object({
  name: z.string().min(2).max(200),
  accountNumber: z.string().regex(/^\d{9,18}$/, "Account number must be 9–18 digits"),
  ifsc: z.string().regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, "Enter a valid 11-character IFSC")
});
const CreateBody = z.object({
  property: z.object({
    addressText: z.string().max(500).optional().nullable(),
    stateCode: z.string().length(2).transform((s) => s.toUpperCase()).optional().nullable(),
    district: z.string().max(120).optional().nullable(), taluk: z.string().max(120).optional().nullable(), hobli: z.string().max(120).optional().nullable(),
    village: z.string().max(120).optional().nullable(), locality: z.string().max(160).optional().nullable(),
    surveyNumber: z.string().max(100).optional().nullable(), subDivisionHissa: z.string().max(50).optional().nullable(),
    pincode: z.string().regex(/^\d{6}$/).optional().nullable().or(z.literal("")).transform((v) => v || null),
    latitude: z.number().optional().nullable(), longitude: z.number().optional().nullable()
  }).refine((p) => !!(p.addressText || p.village || p.locality), { message: "Enter the property's address" }),
  buyer: Party, seller: Party,
  propertyValueINR: z.number().positive().max(1e12),
  advancePercent: z.number().min(1).max(50).optional(),
  consentAccepted: z.literal(true, { message: "Consent is required" })
});

async function loadForActor(req: any, escrowId: string) {
  const e = await one("SELECT e.escrow_id, e.search_id, s.tenant_id, s.created_by FROM title_escrow_contracts e JOIN title_searches s USING (search_id) WHERE e.escrow_id = $1", [escrowId]);
  if (!e || !canSeeSearch(req.actor, e)) throw new HttpError(404, "Escrow not found");
  return e;
}

const wrap = async <T>(fn: () => Promise<T>) => {
  try { return await fn(); } catch (e) { if (e instanceof escrow.EscrowError) throw new HttpError(e.statusCode, e.message); throw e; }
};

export async function escrowRoutes(app: FastifyInstance) {
  app.post("/api/v1/escrow", async (req, reply) => {
    const actor = requireActor(req, ["BUYER", "ADMIN", "BANK_OFFICER"]);
    const body = CreateBody.parse(req.body);
    const e = await wrap(() => escrow.createEscrow(body, actor.userId));
    return reply.code(201).send(e);
  });

  app.get("/api/v1/escrow", async (req) => {
    const actor = requireActor(req);
    const where = actor.role === "ADMIN" || actor.role === "ADVOCATE" ? "TRUE" : "e.created_by = $1";
    return q(`SELECT e.escrow_id, e.search_id, e.escrow_state, e.advance_deposit_amount_inr, e.buyer_name, e.seller_name, e.created_at, s.village_name, s.survey_number, s.state_code, s.verdict
              FROM title_escrow_contracts e JOIN title_searches s USING (search_id) WHERE ${where} ORDER BY e.created_at DESC LIMIT 100`, where === "TRUE" ? [] : [actor.userId]);
  });

  app.get("/api/v1/escrow/:id", async (req) => {
    const { id } = req.params as any;
    await loadForActor(req, id);
    return escrow.getEscrow(id);
  });

  app.post("/api/v1/escrow/:id/esign/:party/start", async (req) => {
    const { id, party } = req.params as any;
    await loadForActor(req, id);
    const P = String(party).toUpperCase();
    if (P !== "BUYER" && P !== "SELLER") throw new HttpError(400, "party must be buyer or seller");
    const { aadhaarLast4 } = z.object({ aadhaarLast4: z.string() }).parse(req.body);
    return wrap(() => escrow.startESign(id, P, aadhaarLast4));
  });

  app.post("/api/v1/escrow/:id/esign/:party/verify", async (req) => {
    const { id } = req.params as any;
    await loadForActor(req, id);
    const { esignId, otp } = z.object({ esignId: z.string().uuid(), otp: z.string().regex(/^\d{6}$/, "OTP is 6 digits") }).parse(req.body);
    return wrap(() => escrow.completeESign(id, esignId, otp));
  });

  /** Sandbox: the buyer pays the advance into the virtual account (UPI/NEFT/RTGS/IMPS). */
  app.post("/api/v1/escrow/:id/deposit", async (req) => {
    const { id } = req.params as any;
    await loadForActor(req, id);
    const { mode, amountINR } = z.object({ mode: z.enum(["UPI", "NEFT", "RTGS", "IMPS"]), amountINR: z.number().positive().optional() }).parse(req.body);
    return wrap(() => escrow.simulateDeposit(id, mode, amountINR));
  });

  /** The escrow as the TitleEscrow smart contract sees it, read live from the chain. */
  app.get("/api/v1/escrow/:id/chain", async (req) => {
    const { id } = req.params as any;
    await loadForActor(req, id);
    return escrowOnChain(id);
  });

  app.get("/api/v1/escrow/:id/agreement.pdf", async (req, reply) => {
    const { id } = req.params as any;
    await loadForActor(req, id);
    const e = await one("SELECT tri_party_esign_doc_uri FROM title_escrow_contracts WHERE escrow_id = $1", [id]);
    return reply.type("application/pdf").header("Content-Disposition", `inline; filename="escrow-agreement-${id}.pdf"`).send(await getObject(e!.tri_party_esign_doc_uri));
  });

  app.get("/api/v1/escrow/:id/bank-statement", async (req) => {
    const { id } = req.params as any;
    await loadForActor(req, id);
    const e = await one("SELECT virtual_account_number FROM title_escrow_contracts WHERE escrow_id = $1", [id]);
    return statement(e!.virtual_account_number);
  });

  // ---- Trustee bank → TitleShield (HMAC-signed) ----
  app.post("/api/v1/webhooks/bank", { config: { rawBody: true } }, async (req, reply) => {
    const raw = (req as any).rawBody as string;
    if (!escrow.verifyBankSignature(raw, req.headers["x-bank-signature"] as string)) throw new HttpError(401, "Bad bank signature");
    const r = await escrow.onBankWebhook(JSON.parse(raw));
    if (r.startSearchId) await startTitleSearch(r.startSearchId);
    return reply.send({ ok: true });
  });
}
