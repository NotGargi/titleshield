import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { STATES, resolveAddress } from "@titleshield/core";
import { config } from "../config.ts";
import { one, q } from "../db/pool.ts";
import { sha256 } from "../crypto/secrets.ts";
import { HttpError, canSeeSearch, requireActor } from "../http/auth.ts";
import { streamSearch } from "../http/sse.ts";
import { startTitleSearch } from "../workflows/engine.ts";
import { putImmutable } from "../storage/worm.ts";
import { DOC_KINDS, extractWithGemini, geminiConfigured, type DocKind } from "../docai/gemini.ts";
import { extractWithoutAi } from "../docai/pdftext.ts";
import { publish } from "../events/bus.ts";
import { getSecret } from "../settings.ts";
import { usageToday } from "../tinyfish/client.ts";
import { resolveLocation, reverse, suggest } from "../geo/geocode.ts";

const opt = (max: number) => z.string().max(max).optional().nullable().transform((v) => v?.trim() || null);
const ExecuteBody = z.object({
  addressText: opt(500),
  stateCode: z.string().length(2).transform((s) => s.toUpperCase()).optional().nullable(),
  district: opt(120),
  taluk: opt(120),
  hobli: opt(120),
  village: opt(120),
  locality: opt(160),
  pincode: z.string().regex(/^\d{6}$/, "PIN code is 6 digits").optional().nullable().or(z.literal("")).transform((v) => v || null),
  latitude: z.number().min(6).max(38).optional().nullable(),
  longitude: z.number().min(68).max(98).optional().nullable(),
  surveyNumber: opt(100),
  subDivisionHissa: z.string().max(50).optional().nullable(),
  claimedOwnerName: z.string().max(255).optional().nullable(),
  escrowId: z.string().uuid().optional().nullable(),
  streamProgress: z.boolean().optional(),
  startImmediately: z.boolean().optional().default(true),
  clientReference: z.string().max(120).optional()
});

export async function searchRoutes(app: FastifyInstance) {
  app.get("/api/v1/meta", async () => {
    const tf = await getSecret("TINYFISH_API_KEY");
    const gm = await getSecret("GEMINI_API_KEY");
    return {
      tinyfish: { configured: !!tf.value, source: tf.source, tier: "free", products: ["Search", "Fetch"], usage: await usageToday().catch(() => null) },
      documentAi: gm.value ? config.GEMINI_MODEL : null,
      workflowEngine: config.WORKFLOW_ENGINE,
      storage: config.STORAGE_DRIVER,
      platformFeeBps: config.PLATFORM_FEE_BPS,
      chain: config.CHAIN_MODE === "off" ? null : { name: config.CHAIN_NAME, mode: config.CHAIN_MODE, chainId: config.CHAIN_ID, explorer: config.CHAIN_EXPLORER_URL || null },
      states: Object.values(STATES).map((s) => ({ code: s.code, name: s.name, language: s.language, hierarchy: s.hierarchy, revenuePortal: s.revenue, encumbrancePortal: s.encumbrance, highCourt: s.highCourt.name, rera: s.rera })),
      demoBankApiKey: config.NODE_ENV === "production" ? undefined : (await import("../db/seed.ts")).DEMO.bankApiKey
    };
  });

  // ---- Location (free OpenStreetMap + India Post) ----
  app.get("/api/v1/geo/suggest", async (req) => {
    const { q: text } = z.object({ q: z.string().min(3).max(200) }).parse(req.query);
    try { return await suggest(text); } catch (e) { throw new HttpError(503, `Address suggestions are unavailable: ${(e as Error).message}`); }
  });
  app.post("/api/v1/geo/resolve", async (req) => {
    const b = z.object({ addressText: opt(500), stateCode: opt(2), district: opt(120), taluk: opt(120), village: opt(120), locality: opt(160), pincode: opt(6), lat: z.number().optional().nullable(), lon: z.number().optional().nullable() }).parse(req.body);
    return resolveLocation({ ...b, stateCode: b.stateCode?.toUpperCase() ?? null });
  });
  app.post("/api/v1/geo/reverse", async (req) => {
    const { lat, lon } = z.object({ lat: z.number().min(6).max(38), lon: z.number().min(68).max(98) }).parse(req.body);
    const r = await reverse(lat, lon).catch((e) => { throw new HttpError(503, `Map lookup unavailable: ${(e as Error).message}`); });
    return resolveLocation({ lat, lon, stateCode: r?.stateCode ?? null });
  });

  app.post("/api/v1/meta/resolve-address", async (req) => {
    const { text } = z.object({ text: z.string().min(3).max(500) }).parse(req.body);
    return resolveAddress(text);
  });

  // ---- PDF §9.1: POST /api/v1/title-search/execute ----
  app.post("/api/v1/title-search/execute", async (req, reply) => {
    const actor = requireActor(req);
    const body = ExecuteBody.parse(req.body);
    if (!body.escrowId) {
      if (!body.addressText && !body.village && !body.locality) throw new HttpError(400, "Enter the property's address");
      if (!body.stateCode || !body.district || !(body.village || body.locality)) {
        const loc = await resolveLocation({ addressText: body.addressText, stateCode: body.stateCode, district: body.district, taluk: body.taluk, village: body.village, locality: body.locality, pincode: body.pincode, lat: body.latitude, lon: body.longitude });
        body.stateCode = body.stateCode ?? loc.stateCode;
        body.district = body.district ?? loc.district;
        body.taluk = body.taluk ?? loc.taluk;
        body.village = body.village ?? loc.village;
        body.locality = body.locality ?? loc.locality;
        body.pincode = body.pincode ?? loc.pincode;
        body.latitude = body.latitude ?? loc.lat;
        body.longitude = body.longitude ?? loc.lon;
      }
      if (!body.stateCode || !STATES[body.stateCode]) throw new HttpError(400, "Couldn't work out the state from this address. Choose the state.");
      if (!body.district) throw new HttpError(400, "Couldn't work out the district from this address. Enter the district.");
      if (!body.village && !body.locality) throw new HttpError(400, "Enter the village or locality.");
    }

    // An escrow-linked search starts from the bank deposit; return that search's stream.
    if (body.escrowId) {
      const e = await one("SELECT e.search_id, s.tenant_id, s.created_by FROM title_escrow_contracts e JOIN title_searches s USING (search_id) WHERE e.escrow_id = $1", [body.escrowId]);
      if (!e || !canSeeSearch(actor, e)) throw new HttpError(404, "Escrow not found");
      return streamSearch(req, reply, e.search_id, { preamble: { searchId: e.search_id, escrowId: body.escrowId, note: "Escrow-linked search starts when the advance is credited" } });
    }

    const idem = req.headers["idempotency-key"];
    const reqHash = sha256(JSON.stringify(body));
    if (typeof idem === "string" && idem) {
      const prior = await one("SELECT search_id, request_hash FROM idempotency_keys WHERE tenant_id = $1 AND idem_key = $2", [actor.tenantId, idem]);
      if (prior) {
        if (prior.request_hash !== reqHash) throw new HttpError(422, "Idempotency-Key reused with a different request body");
        return reply.code(200).send({ searchId: prior.search_id, idempotentReplay: true, statusUrl: `/api/v1/title-search/${prior.search_id}` });
      }
    }

    const tier = actor.kind === "apikey" ? "BANK_B2B_API" : "RETAIL_B2C";
    const s = await one(`INSERT INTO title_searches (tenant_id, tier_type, state_code, district_name, taluk_name, hobli_name, village_name, survey_number, sub_division_hissa,
        claimed_owner_name, created_by, client_reference, address_text, locality, pincode, latitude, longitude, portal_mode)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'live') RETURNING search_id`,
      [actor.tenantId, tier, body.stateCode, body.district, body.taluk ?? "", body.hobli, body.village ?? body.locality, body.surveyNumber ?? "", body.subDivisionHissa ?? null,
       body.claimedOwnerName?.trim() || null, actor.userId, body.clientReference ?? null, body.addressText, body.locality, body.pincode, body.latitude ?? null, body.longitude ?? null]);
    const searchId = s!.search_id as string;
    if (typeof idem === "string" && idem) await q("INSERT INTO idempotency_keys (idem_key, tenant_id, request_hash, search_id) VALUES ($1,$2,$3,$4)", [idem, actor.tenantId, reqHash, searchId]);
    await q("INSERT INTO consent_artifacts (principal_name, principal_user_id, purpose, notice_text, notice_sha256, search_id) VALUES ($1,$2,'TITLE_SEARCH',$3,$4,$5)",
      [actor.name, actor.userId, "Search of public land, registration, court and mortgage records for the property identified in this request.", sha256("TITLE_SEARCH_NOTICE_V1"), searchId]);

    if (body.startImmediately) await startTitleSearch(searchId);
    const links = { searchId, statusUrl: `/api/v1/title-search/${searchId}`, eventsUrl: `/api/v1/title-search/${searchId}/events`, mode: "live" };
    const stream = body.streamProgress ?? (tier === "RETAIL_B2C" && body.startImmediately);
    if (stream) return streamSearch(req, reply, searchId, { preamble: links, closeOnReview: true });
    return reply.code(202).send({ ...links, status: body.startImmediately ? "QUEUED" : "AWAITING_DOCUMENTS", webhook: tier === "BANK_B2B_API" ? "title_search.completed will be POSTed to your registered webhook" : undefined });
  });

  app.post("/api/v1/title-search/:id/start", async (req, reply) => {
    const actor = requireActor(req);
    const s = await one("SELECT search_id, tenant_id, created_by, status, tier_type FROM title_searches WHERE search_id = $1", [(req.params as any).id]);
    if (!s || !canSeeSearch(actor, s)) throw new HttpError(404, "Search not found");
    if (s.tier_type === "ESCROW_LINKED") throw new HttpError(409, "Escrow-linked searches start when the advance is credited");
    if (s.status !== "QUEUED") throw new HttpError(409, `Search is already ${s.status}`);
    await startTitleSearch(s.search_id);
    return reply.code(202).send({ searchId: s.search_id, status: "STARTED" });
  });

  app.get("/api/v1/title-search/:id/events", async (req, reply) => {
    const s = await one("SELECT search_id, tenant_id, created_by FROM title_searches WHERE search_id = $1", [(req.params as any).id]);
    if (!s || !canSeeSearch(req.actor, s)) throw new HttpError(404, "Search not found");
    return streamSearch(req, reply, s.search_id);
  });

  app.get("/api/v1/title-search/:id", async (req) => {
    const s = await one("SELECT * FROM title_searches WHERE search_id = $1", [(req.params as any).id]);
    if (!s || !canSeeSearch(req.actor, s)) throw new HttpError(404, "Search not found");
    const runs = await q(`SELECT run_id, portal_code, agent_role, status, mode, from_cache, tinyfish_session_id, goal_prompt_version, streaming_url, error, started_at, finished_at, extracted_json, search_log
                          FROM tinyfish_agent_runs WHERE search_id = $1 ORDER BY started_at`, [s.search_id]);
    const docs = await q("SELECT document_id, kind, filename, sha256, pages, language, status, error, extracted_json, created_at FROM documents WHERE search_id = $1", [s.search_id]);
    const escrow = await one("SELECT escrow_id, escrow_state FROM title_escrow_contracts WHERE search_id = $1", [s.search_id]);
    const review = await one("SELECT r.*, u.full_name AS advocate_name FROM advocate_reviews r LEFT JOIN users u ON u.user_id = r.advocate_user_id WHERE search_id = $1", [s.search_id]);
    const monitor = await q("SELECT subscription_id, interval_minutes, active, until_date, last_run_at, last_status FROM monitor_subscriptions WHERE search_id = $1", [s.search_id]);
    const alerts = await q("SELECT a.kind, a.detail, a.created_at FROM monitor_alerts a JOIN monitor_subscriptions m USING (subscription_id) WHERE m.search_id = $1 ORDER BY a.created_at", [s.search_id]);
    const { tenant_id, created_by, ...rest } = s;
    return { ...rest, agentRuns: runs, documents: docs, escrow, review, monitor, alerts, certificateUrl: s.certificate_id ? `/api/v1/certificates/${s.certificate_id}.pdf` : null };
  });

  app.get("/api/v1/title-search", async (req) => {
    const actor = requireActor(req);
    const scoped = actor.role === "ADMIN" || actor.role === "ADVOCATE" ? ["TRUE", []] : actor.kind === "apikey" || actor.role === "BANK_OFFICER" ? ["tenant_id = $1", [actor.tenantId]] : ["created_by = $1", [actor.userId]];
    return q(`SELECT search_id, tier_type, state_code, district_name, taluk_name, village_name, survey_number, claimed_owner_name, status, verdict,
              encumbrance_clearance_score, certificate_id, portal_mode, created_at, completed_at FROM title_searches WHERE ${scoped[0]} ORDER BY created_at DESC LIMIT 100`, scoped[1] as any[]);
  });

  // ---- vernacular documents ----
  app.post("/api/v1/title-search/:id/documents", async (req) => {
    const actor = requireActor(req);
    const s = await one("SELECT search_id, tenant_id, created_by, status FROM title_searches WHERE search_id = $1", [(req.params as any).id]);
    if (!s || !canSeeSearch(actor, s)) throw new HttpError(404, "Search not found");
    if (s.status !== "QUEUED") throw new HttpError(409, "Documents must be added before the search starts");
    const file = await req.file({ limits: { fileSize: 15 * 1024 * 1024 } });
    if (!file) throw new HttpError(400, "Attach a PDF or image");
    const kind = String((file.fields.kind as any)?.value ?? "EC").toUpperCase() as DocKind;
    if (!DOC_KINDS[kind]) throw new HttpError(400, `kind must be one of ${Object.keys(DOC_KINDS).join(", ")}`);
    if (!/^(application\/pdf|image\/(png|jpe?g|webp))$/.test(file.mimetype)) throw new HttpError(415, "Upload a PDF, PNG, JPEG or WebP file");
    const buf = await file.toBuffer();
    const stored = await putImmutable(`searches/${s.search_id}/uploads/${sha256(buf)}-${file.filename.replace(/[^\w.\-]/g, "_")}`, buf, file.mimetype);
    const d = await one("INSERT INTO documents (search_id, kind, filename, mime_type, sha256, storage_uri) VALUES ($1,$2,$3,$4,$5,$6) RETURNING document_id, sha256",
      [s.search_id, kind, file.filename, file.mimetype, stored.sha256, stored.uri]);
    await publish(s.search_id, "document_uploaded", { documentId: d!.document_id, filename: file.filename, kind, sha256: stored.sha256 });
    return { documentId: d!.document_id, sha256: stored.sha256, willExtractWith: (await geminiConfigured()) ? config.GEMINI_MODEL : "PDF text layer" };
  });

  /** Read one document right away (no search) — useful to preview Document AI on your own EC. */
  app.post("/api/v1/documents/extract", async (req) => {
    requireActor(req);
    const file = await req.file({ limits: { fileSize: 15 * 1024 * 1024 } });
    if (!file) throw new HttpError(400, "Attach a PDF or image");
    const kind = String((file.fields.kind as any)?.value ?? "EC").toUpperCase() as DocKind;
    const survey = String((file.fields.surveyNumber as any)?.value ?? "");
    const args = { data: await file.toBuffer(), mimeType: file.mimetype, kind: DOC_KINDS[kind] ? kind : "EC" as DocKind, surveyNumber: survey };
    return (await geminiConfigured()) ? extractWithGemini(args) : extractWithoutAi(args);
  });
}
