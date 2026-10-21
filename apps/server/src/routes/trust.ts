import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { one, q } from "../db/pool.ts";
import { HttpError, requireActor } from "../http/auth.ts";
import { getObject, objectRetention } from "../storage/worm.ts";
import { anchorHour, anchorPendingHours, certificateProof, verifyWholeLedger } from "../ledger/ledger.ts";
import { caCertPem, loadSigner } from "../crypto/pki.ts";
import { oraclePublicKeyPem } from "../escrow/oracle.ts";
import { resumeAfterAdvocate, startTitleSearch } from "../workflows/engine.ts";
import { runMonitorCheck } from "../workflows/activities.ts";
import { publish } from "../events/bus.ts";
import { config } from "../config.ts";

/** Certificates, public verification, ledger, PKI, advocate console and monitoring. */
export async function trustRoutes(app: FastifyInstance) {
  app.get("/api/v1/certificates/:file", async (req, reply) => {
    const id = String((req.params as any).file).replace(/\.pdf$/, "");
    const row = await one("SELECT pdf_storage_uri FROM immutable_certificate_ledger WHERE certificate_id = $1", [id]);
    if (!row) throw new HttpError(404, "Certificate not found");
    return reply.type("application/pdf").header("Content-Disposition", `inline; filename="${id}.pdf"`).send(await getObject(row.pdf_storage_uri));
  });

  // Public verification page data (PDF §5.1 verificationUrl)
  app.get("/api/v1/verify/:certId", async (req) => {
    const proof = await certificateProof((req.params as any).certId);
    if (!proof) throw new HttpError(404, "No certificate with this ID exists in the TitleShield ledger");
    const r = proof.row;
    const signer = loadSigner();
    return {
      certificateId: r.certificate_id, documentType: r.document_type, issuedAt: r.recorded_at_iso, sequenceNo: Number(r.sequence_no),
      payload: r.payload_canonical_json, pdfSha256: r.pdf_sha256, evidenceSha256: r.evidence_hash, propertyHash: r.property_hash,
      previousRowHash: r.previous_row_hash, currentRowHash: r.current_row_hash,
      chainValidUpToThisRow: proof.chainValidUpToThisRow, merkle: proof.merkle,
      retention: await objectRetention(r.pdf_storage_uri).catch(() => null),
      signer: { serial: r.signer_serial, subject: signer.subject, issuer: signer.issuer, validUntil: signer.notAfter, development: /DEV/.test(signer.subject) }
    };
  });

  app.post("/api/v1/verify/upload", async (req) => {
    const file = await req.file({ limits: { fileSize: 20 * 1024 * 1024 } });
    if (!file) throw new HttpError(400, "Attach the certificate PDF");
    const hash = crypto.createHash("sha256").update(await file.toBuffer()).digest("hex");
    const row = await one("SELECT certificate_id, document_type, recorded_at_iso FROM immutable_certificate_ledger WHERE pdf_sha256 = $1", [hash]);
    return row ? { match: true, sha256: hash, certificateId: row.certificate_id, documentType: row.document_type, issuedAt: row.recorded_at_iso }
      : { match: false, sha256: hash, message: "This file does not match any certificate issued by TitleShield. It may have been altered." };
  });

  app.get("/api/v1/ledger", async () => {
    const rows = await q(`SELECT sequence_no, certificate_id, document_type, previous_row_hash, current_row_hash, recorded_at_iso FROM immutable_certificate_ledger ORDER BY sequence_no DESC LIMIT 50`);
    const anchors = await q("SELECT anchor_id, period_start, period_end, first_sequence, last_sequence, leaf_count, merkle_root, tsa_status, tsa_url FROM merkle_anchors ORDER BY period_start DESC LIMIT 24");
    return { integrity: await verifyWholeLedger(), rows, anchors };
  });

  app.post("/api/v1/ledger/anchor", async (req) => {
    requireActor(req, ["ADMIN"]);
    const pending = await anchorPendingHours();
    const h = new Date(); h.setUTCMinutes(0, 0, 0);
    const current = await anchorHour(h, true);
    return { anchoredPastHours: pending.length, currentHour: current };
  });

  app.get("/api/v1/pki/ca.crt", async (_req, reply) => reply.type("application/x-pem-file").send(caCertPem()));
  app.get("/api/v1/pki/oracle.pub", async (_req, reply) => reply.type("application/x-pem-file").send(oraclePublicKeyPem()));

  // ---- Empanelled advocate review console (PDF §10.4) ----
  app.get("/api/v1/advocate/queue", async (req) => {
    requireActor(req, ["ADVOCATE", "ADMIN"]);
    return q(`SELECT r.review_id, r.search_id, r.reason, r.sla_due_at, r.decision, r.decided_at, r.notes, r.created_at,
              s.state_code, s.district_name, s.taluk_name, s.village_name, s.survey_number, s.claimed_owner_name, s.encumbrance_clearance_score, s.status, s.tier_type,
              (SELECT escrow_state FROM title_escrow_contracts e WHERE e.search_id = s.search_id) AS escrow_state
              FROM advocate_reviews r JOIN title_searches s USING (search_id) ORDER BY (r.decision IS NULL) DESC, r.sla_due_at`);
  });

  app.post("/api/v1/advocate/:searchId/decision", async (req) => {
    const actor = requireActor(req, ["ADVOCATE", "ADMIN"]);
    const { decision, notes } = z.object({ decision: z.enum(["APPROVE", "REJECT"]), notes: z.string().min(10, "Record at least a sentence on what you checked").max(4000) }).parse(req.body);
    const searchId = (req.params as any).searchId;
    const r = await one(`UPDATE advocate_reviews SET decision = $2, notes = $3, advocate_user_id = $4, decided_at = NOW()
                         WHERE search_id = $1 AND decision IS NULL RETURNING review_id`, [searchId, decision, notes, actor.userId]);
    if (!r) throw new HttpError(409, "This review is already decided or does not exist");
    await publish(searchId, "advocate_decision", { decision, notes, advocate: actor.name });
    await resumeAfterAdvocate(searchId, decision);
    return { ok: true, decision };
  });

  // ---- Continuous monitoring ----
  app.post("/api/v1/monitor/:subscriptionId/run", async (req) => {
    requireActor(req);
    return runMonitorCheck((req.params as any).subscriptionId);
  });

  // ---- Dev helpers (never in production) ----
  if (config.NODE_ENV !== "production") {
    const sink: any[] = [];
    app.post("/api/v1/dev/webhook-sink", async (req) => { sink.unshift({ at: new Date().toISOString(), headers: { event: req.headers["x-titleshield-event"], signature: req.headers["x-titleshield-signature"] }, body: req.body }); sink.length = Math.min(sink.length, 50); return { ok: true }; });
    app.get("/api/v1/dev/webhook-sink", async () => sink);

    app.post("/api/v1/dev/rerun/:searchId", async (req) => {
      requireActor(req, ["ADMIN"]);
      await startTitleSearch((req.params as any).searchId);
      return { ok: true };
    });
  }
}
