import crypto from "node:crypto";
import {
  AGENT_ROLES, STATES, applyAdvocateDecision, assessTitle, canonicalJson, isIndic, propertyHash, sha256Hex, transliterate,
  type AgentRole, type PortalExtraction, type TitleAssessment, type TitleClearanceOutput
} from "@titleshield/core";
import { config } from "../config.ts";
import { one, q } from "../db/pool.ts";
import { publish } from "../events/bus.ts";
import { checkPortals, runWebAgent, type AgentQuery } from "../agents/webAgents.ts";
import { runRecordsAgent } from "../agents/records.ts";
import { recordedScenario } from "../tinyfish/recorded.ts";
import { resolveLocation } from "../geo/geocode.ts";
import { geminiConfigured } from "../docai/gemini.ts";
import { getObject, putImmutable, tarZst } from "../storage/worm.ts";
import { renderAndSign } from "../certs/tcc.ts";
import { appendToLedger } from "../ledger/ledger.ts";
import * as escrow from "../escrow/service.ts";
import { deliverTenantWebhook } from "../webhooks/outbound.ts";

/**
 * Activities: every side-effecting step of a title search. Both workflow engines
 * (Temporal and the in-process engine) call exactly these functions.
 */

export interface AgentSummary { role: AgentRole; portal: string; status: string; durationMs: number; error: string | null; strong: number; medium: number }
export interface ScoreSummary { verdict: string; escrowAction: string; score: number }
export interface CertSummary { certificateId: string; documentType: string; verdict: string; escrowAction: "RELEASE_TO_SELLER" | "REFUND_TO_BUYER" | "DISPUTE_HOLD"; evidenceHash: string; escrowLinked: boolean }
export interface BeginInfo { tier: string; allowCache: boolean; maxPortalRetries: number; escrowLinked: boolean }

const WEB_ROLES = new Set<AgentRole>(["COURTS", "BANK_NOTICES", "GOVT_NOTICES"]);

async function searchRow(searchId: string) {
  const s = await one("SELECT * FROM title_searches WHERE search_id = $1", [searchId]);
  if (!s) throw new Error(`search ${searchId} not found`);
  return s;
}

export async function queryFor(searchId: string): Promise<AgentQuery> {
  const s = await searchRow(searchId);
  return {
    stateCode: s.state_code, district: s.district_name, taluk: s.taluk_name, village: s.village_name, surveyNumber: s.survey_number ?? "",
    hobli: s.hobli_name, subDivisionHissa: s.sub_division_hissa, claimedOwnerName: s.claimed_owner_name,
    locality: s.locality, addressText: s.address_text, pincode: s.pincode
  };
}

export async function beginSearch(searchId: string): Promise<BeginInfo> {
  const s = await searchRow(searchId);
  await q("UPDATE title_searches SET status = 'RUNNING_TINYFISH', portal_mode = 'live' WHERE search_id = $1", [searchId]);
  await publish(searchId, "agent_spawned", { agents: AGENT_ROLES, mode: "live", tinyfish: "free tier (Search + Fetch)", elapsedMs: 0 });
  const escrowLinked = s.tier_type === "ESCROW_LINKED";
  return { tier: s.tier_type, allowCache: !escrowLinked, maxPortalRetries: s.tier_type === "BANK_B2B_API" ? 2 : 1, escrowLinked };
}

/** Resolve the address to state / district / taluk / village / PIN / map point, and check the state portals. */
export async function resolveLocationStep(searchId: string) {
  const s = await searchRow(searchId);
  const loc = await resolveLocation({
    addressText: s.address_text, stateCode: s.state_code, district: s.district_name, taluk: s.taluk_name, village: s.village_name,
    locality: s.locality, pincode: s.pincode, lat: s.latitude, lon: s.longitude
  });
  await q(`UPDATE title_searches SET district_name = COALESCE(NULLIF(district_name, ''), $2), taluk_name = COALESCE(NULLIF(taluk_name, ''), $3),
           village_name = COALESCE(NULLIF(village_name, ''), $4), locality = COALESCE(locality, $5), pincode = COALESCE(pincode, $6),
           latitude = COALESCE(latitude, $7), longitude = COALESCE(longitude, $8), location_json = $9 WHERE search_id = $1`,
    [searchId, loc.district ?? "", loc.taluk ?? "", loc.village ?? "", loc.locality, loc.pincode, loc.lat, loc.lon, JSON.stringify(loc)]);
  const st = STATES[s.state_code];
  let portals: Awaited<ReturnType<typeof checkPortals>> = [];
  try { portals = await checkPortals(st, { recorded: !!recordedScenario(await queryFor(searchId)) }); } catch { /* TinyFish not configured: links still shown */ }
  if (!portals.length) portals = [st.revenue && { role: "Record of Rights", ...st.revenue, reachable: null, note: "" }, st.encumbrance && { role: "Encumbrance Certificate", ...st.encumbrance, reachable: null, note: "" }].filter(Boolean) as any;
  await publish(searchId, "location_resolved", { location: loc, state: { code: st.code, name: st.name, language: st.language, hierarchy: st.hierarchy, highCourt: st.highCourt.name }, portals });
  return { ok: true };
}

export async function runAgent(searchId: string, role: AgentRole, allowCache: boolean): Promise<AgentSummary> {
  const o = role === "RECORDS" ? await runRecordsAgent(searchId) : await runWebAgent(searchId, role, await queryFor(searchId), { fresh: !allowCache });
  return {
    role, portal: o.portalCode, status: o.status, durationMs: o.durationMs, error: o.error,
    strong: o.findings.filter((f) => f.strength === "STRONG").length, medium: o.findings.filter((f) => f.strength === "MEDIUM").length
  };
}

export async function note(searchId: string, event: string, data: Record<string, unknown>) {
  await publish(searchId, event, data);
}

/** Summary of what was read: documents, scripts found, names matched across scripts. */
export async function documentIntelligence(searchId: string, _agents: AgentSummary[]) {
  await q("UPDATE title_searches SET status = 'OCR_PARSING' WHERE search_id = $1", [searchId]);
  const s = await searchRow(searchId);
  const docs = await q("SELECT filename, kind, status, error, pages, language, extracted_json FROM documents WHERE search_id = $1 ORDER BY created_at", [searchId]);
  const names = new Set<string>();
  for (const d of docs) {
    const x = d.extracted_json as PortalExtraction | null;
    if (!x) continue;
    x.currentOwnerNames.forEach((n) => names.add(n));
    x.mutationHistory.forEach((m) => { names.add(m.transferor); names.add(m.transferee); });
    x.encumbrances.forEach((e) => { if (e.executant) names.add(e.executant); if (e.claimant) names.add(e.claimant); });
  }
  const translit = [...names].filter((n) => n && isIndic(n)).slice(0, 10).map((n) => ({ original: n, latin: transliterate(n) }));
  const scripts = [...new Set(docs.flatMap((d) => (d.language ?? "").split(",").filter(Boolean)))];
  await publish(searchId, "ocr_completed", {
    pagesProcessed: docs.reduce((n, d) => n + (d.pages ?? 0), 0),
    uploadedDocuments: docs.map((d) => ({ document: d.filename, kind: d.kind, status: d.status, error: d.error })),
    scriptsDetected: scripts,
    vernacularLanguage: STATES[s.state_code]?.langCode,
    legacyFontFieldsDecoded: 0,
    transliterations: translit,
    documentAi: (await geminiConfigured()) ? config.GEMINI_MODEL : "PDF text layer (no Gemini key)"
  });
}

async function loadExtractions(searchId: string): Promise<{ extractions: PortalExtraction[]; failed: string[]; runs: any[] }> {
  const runs = await q(`SELECT DISTINCT ON (agent_role) agent_role, portal_code, status, extracted_json, mode, from_cache, raw_sse_log_s3_uri, search_log
                        FROM tinyfish_agent_runs WHERE search_id = $1 ORDER BY agent_role, started_at DESC`, [searchId]);
  const extractions: PortalExtraction[] = runs.filter((r) => ["SUCCESS", "NO_RECORD", "INCOMPLETE"].includes(r.status) && r.extracted_json).map((r) => r.extracted_json);
  const label: Record<string, string> = { NOT_CONFIGURED: "TinyFish key missing", RATE_LIMITED: "free limit reached", FAILED: "failed", NO_RECORD: "not enough details to search", TIMEOUT: "timed out", INCOMPLETE: "incomplete — some evidence could not be retrieved" };
  const failed = runs.filter((r) => WEB_ROLES.has(r.agent_role) && r.status !== "SUCCESS").map((r) => `${r.portal_code.replace("WEB_", "").replace(/_/g, " ").toLowerCase()} check: ${label[r.status] ?? r.status}`);
  const missing = [...WEB_ROLES].filter((role) => !runs.some((r) => r.agent_role === role));
  const docs = await q("SELECT extracted_json FROM documents WHERE search_id = $1 AND status = 'EXTRACTED'", [searchId]);
  return { extractions: [...extractions, ...docs.map((d) => d.extracted_json)], failed: [...failed, ...missing.map((m) => `${m.toLowerCase()} check: not run`)], runs };
}

export async function scoreTitle(searchId: string): Promise<ScoreSummary> {
  await q("UPDATE title_searches SET status = 'SCORING' WHERE search_id = $1", [searchId]);
  const s = await searchRow(searchId);
  const { extractions, failed } = await loadExtractions(searchId);
  const a = assessTitle({ extractions, surveyNumber: s.survey_number, claimedOwnerName: s.claimed_owner_name, failedPortals: failed });
  await q(`UPDATE title_searches SET assessment = $2, has_active_mortgage = $3, pending_litigation_count = $4, last_owner_name = $5,
           encumbrance_clearance_score = $6, verdict = $7, escrow_action = $8 WHERE search_id = $1`,
    [searchId, JSON.stringify(a), a.hasActiveMortgage, a.pendingLitigationCount, a.lastOwnerName.slice(0, 255), a.score, a.verdict, a.escrowAction]);
  await publish(searchId, "title_scored", {
    score: a.score, rawScore: a.rawScore, verdict: a.verdict, escrowAction: a.escrowAction,
    rules: a.rules.map((r) => ({ id: r.id, kind: r.kind, label: r.label, hit: r.hit, weight: r.weight ?? null, detail: r.detail })),
    liens: a.liens, litigation: a.litigation, chain: a.chain, ownerMatch: a.ownerMatch, lastOwnerName: a.lastOwnerName
  });
  return { verdict: a.verdict, escrowAction: a.escrowAction, score: a.score };
}

export async function openAdvocateReview(searchId: string) {
  const s = await searchRow(searchId);
  const a: TitleAssessment = s.assessment;
  const reason = a.rules.filter((r) => r.hit).map((r) => `${r.id} ${r.label}`).join("; ") || "Score in review band";
  await q(`INSERT INTO advocate_reviews (search_id, reason, sla_due_at) VALUES ($1, $2, NOW() + interval '2 hours') ON CONFLICT (search_id) DO NOTHING`, [searchId, reason]);
  await q("UPDATE title_searches SET status = 'MANUAL_REVIEW' WHERE search_id = $1", [searchId]);
  await publish(searchId, "advocate_review_opened", { reason, slaHours: 2 });
}

export async function issueCertificate(searchId: string): Promise<CertSummary> {
  const s = await searchRow(searchId);
  const a: TitleAssessment = s.assessment;
  const review = await one("SELECT r.*, u.full_name FROM advocate_reviews r LEFT JOIN users u ON u.user_id = r.advocate_user_id WHERE r.search_id = $1", [searchId]);
  const final = review?.decision ? applyAdvocateDecision(a, review.decision) : { verdict: a.verdict, escrowAction: a.escrowAction };
  const finalVerdict = final.verdict;
  const docType = finalVerdict === "CLEAN_TITLE" ? "TITLE_CLEARANCE_CERTIFICATE" : finalVerdict === "REJECTED" ? "TITLE_DEFECT_REPORT" : "CONDITIONAL_TITLE_REPORT";
  const prefix = docType === "TITLE_CLEARANCE_CERTIFICATE" ? "TCC" : docType === "TITLE_DEFECT_REPORT" ? "TDR" : "TCR";
  const issuedAt = new Date();
  const certificateId = `${prefix}-${s.state_code}-${issuedAt.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomInt(10000, 99999)}`;

  // Evidence bundle (.tar.zst) → WORM (PDF §7.1)
  const { runs } = await loadExtractions(searchId);
  const files: Array<{ name: string; data: Buffer | string }> = [];
  for (const r of runs) {
    if (r.raw_sse_log_s3_uri) { try { files.push({ name: `agents/${r.portal_code}.trace.json`, data: await getObject(r.raw_sse_log_s3_uri) }); } catch { /* evidence missing */ } }
    if (r.extracted_json) files.push({ name: `agents/${r.portal_code}.extraction.json`, data: JSON.stringify(r.extracted_json, null, 2) });
  }
  const docs = await q("SELECT filename, sha256, storage_uri, extracted_json FROM documents WHERE search_id = $1", [searchId]);
  for (const d of docs) files.push({ name: `documents/${d.sha256}.json`, data: JSON.stringify(d, null, 2) });
  files.push({ name: "assessment.json", data: JSON.stringify(a, null, 2) });
  if (review) files.push({ name: "advocate-review.json", data: JSON.stringify(review, null, 2) });
  const events = await q("SELECT event, data, created_at FROM search_events WHERE search_id = $1 ORDER BY event_id", [searchId]);
  files.push({ name: "event-stream.json", data: JSON.stringify(events, null, 2) });
  const bundle = await putImmutable(`searches/${searchId}/evidence-${certificateId}.tar.zst`, tarZst(files), "application/zstd");

  const property = { state: s.state_code, district: s.district_name, taluk: s.taluk_name, village: s.village_name, surveyNumber: s.survey_number };
  const verificationUrl = `${config.WEB_BASE_URL}/verify/${certificateId}`;
  const output: TitleClearanceOutput = {
    searchId, propertyIdentifier: property,
    hasActiveMortgage: a.hasActiveMortgage, pendingLitigationCount: a.pendingLitigationCount, lastOwnerName: a.lastOwnerName,
    encumbranceClearanceScore: a.score, riskBreakdown: a.riskBreakdown,
    certificateMetadata: { certificateId, sha256DocumentHash: "", dscSignatureSerial: "", verificationUrl }
  };
  const payloadForHash = { ...output, verdict: finalVerdict, evidenceBundleSha256: bundle.sha256, issuedAt: issuedAt.toISOString() };
  output.certificateMetadata.sha256DocumentHash = sha256Hex(canonicalJson(payloadForHash));

  const st = STATES[s.state_code];
  const signed = await renderAndSign({
    documentType: docType, certificateId, output, assessment: { ...a, verdict: finalVerdict, escrowAction: final.escrowAction },
    query: { stateName: st?.name ?? s.state_code, district: s.district_name, taluk: s.taluk_name, village: s.village_name, surveyNumber: s.survey_number, claimedOwnerName: s.claimed_owner_name, addressText: s.address_text },
    sources: [
      ...runs.map((r) => ({ portal: r.portal_code === "OWNER_DOCUMENTS" ? "Owner's documents (EC / RoR / deeds)" : r.portal_code.replace("WEB_", "").replace(/_/g, " ").toLowerCase() + " (TinyFish free Search + Fetch)", status: r.status, mode: (r.search_log ?? []).length ? `${r.search_log.length} searches` : r.mode ?? "", fromCache: false })),
      ...docs.map((d) => ({ portal: `Uploaded: ${d.filename}`, status: d.extracted_json ? "READ" : "NOT READ", mode: "document", fromCache: false }))
    ],
    findings: (await loadExtractions(searchId)).extractions.flatMap((x) => x.findings ?? []).filter((f) => f.strength !== "WEAK" || f.kind === "RERA_PROJECT"),
    evidenceHash: bundle.sha256, issuedAt,
    advocate: review?.decision ? { name: review.full_name ?? "Empanelled advocate", decision: review.decision, notes: review.notes ?? "" } : null
  });
  output.certificateMetadata.dscSignatureSerial = signed.signerSerial;
  const pdf = await putImmutable(`certificates/${certificateId}.pdf`, signed.pdf, "application/pdf");

  const escrowRow = await escrow.escrowForSearch(searchId);
  const ledger = await appendToLedger({
    certificateId, searchId, escrowId: escrowRow?.escrow_id ?? null, payload: { ...payloadForHash, certificateMetadata: output.certificateMetadata },
    documentType: docType, propertyHash: propertyHash(property), evidenceHash: bundle.sha256, pdfSha256: pdf.sha256, pdfUri: pdf.uri, signerSerial: signed.signerSerial
  });

  await q(`UPDATE title_searches SET status = 'COMPLETED', verdict = $2, escrow_action = $3, certificate_id = $4, certificate_pdf_s3_uri = $5,
           worm_evidence_s3_uri = $6, evidence_sha256_hash = $7, output_json = $8, completed_at = NOW(),
           execution_duration_ms = (EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000)::int WHERE search_id = $1`,
    [searchId, finalVerdict, final.escrowAction, certificateId, pdf.uri, bundle.uri, bundle.sha256, JSON.stringify(output)]);

  const certificateUrl = `${config.PUBLIC_BASE_URL}/api/v1/certificates/${certificateId}.pdf`;
  await publish(searchId, "title_clearance_result", {
    hasActiveMortgage: output.hasActiveMortgage, pendingLitigationCount: output.pendingLitigationCount, lastOwnerName: output.lastOwnerName,
    encumbranceClearanceScore: output.encumbranceClearanceScore, verdict: finalVerdict, documentType: docType,
    escrowActionTriggered: escrowRow ? final.escrowAction : null, certificateId, certificateUrl, verificationUrl,
    ledger: { sequenceNo: ledger.sequenceNo, hash: ledger.currentHash }, output
  });
  return { certificateId, documentType: docType, verdict: finalVerdict, escrowAction: final.escrowAction, evidenceHash: bundle.sha256, escrowLinked: !!escrowRow };
}

export async function settleEscrow(searchId: string, action: CertSummary["escrowAction"], certificateId: string | null, evidenceHash: string | null, verdict: string) {
  const r = await escrow.settle(searchId, action, { certificateId: certificateId ?? "", evidenceHash: evidenceHash ?? "", verdict, actor: "oracle" });
  if (r) await publish(searchId, "escrow_settled", { action, ...(r as object) });
  return r ? JSON.parse(JSON.stringify(r)) : null;
}

export async function startMonitoring(searchId: string) {
  const e = await escrow.escrowForSearch(searchId);
  const { extractions } = await loadExtractions(searchId);
  const baseline = { urls: [...new Set(extractions.flatMap((x) => (x.findings ?? []).filter((f) => f.strength !== "WEAK").map((f) => f.url)))] };
  const until = new Date(Date.now() + 45 * 86400 * 1000).toISOString().slice(0, 10);
  const sub = await one(`INSERT INTO monitor_subscriptions (search_id, escrow_id, baseline_json, interval_minutes, until_date) VALUES ($1,$2,$3,$4,$5) RETURNING subscription_id`,
    [searchId, e?.escrow_id ?? null, JSON.stringify(baseline), config.MONITOR_INTERVAL_MINUTES, until]);
  await publish(searchId, "monitor_started", { subscriptionId: sub!.subscription_id, intervalMinutes: config.MONITOR_INTERVAL_MINUTES, until, watching: ["BANK_NOTICES", "COURTS", "GOVT_NOTICES"] });
  return { subscriptionId: sub!.subscription_id as string, intervalMinutes: config.MONITOR_INTERVAL_MINUTES, until };
}

/** One continuous-monitoring pass: fresh free searches for new bank notices, cases and notifications. */
export async function runMonitorCheck(subscriptionId: string) {
  const sub = await one("SELECT * FROM monitor_subscriptions WHERE subscription_id = $1", [subscriptionId]);
  if (!sub || !sub.active) return { active: false, alerts: 0 };
  if (new Date(sub.until_date) < new Date()) { await q("UPDATE monitor_subscriptions SET active = FALSE WHERE subscription_id = $1", [subscriptionId]); return { active: false, alerts: 0 }; }
  const searchId = sub.search_id;
  await publish(searchId, "monitor_check_started", { subscriptionId });
  const query = await queryFor(searchId);
  const known = new Set<string>(sub.baseline_json.urls ?? []);
  const alerts: any[] = [];
  for (const role of ["BANK_NOTICES", "COURTS", "GOVT_NOTICES"] as const) {
    const o = await runWebAgent(searchId, role, query, { fresh: true });
    for (const f of o.findings) {
      if (f.strength === "WEAK" || known.has(f.url)) continue;
      known.add(f.url);
      alerts.push({ kind: f.kind === "BANK_NOTICE" ? "NEW_BANK_NOTICE" : f.kind === "COURT_CASE" ? "NEW_LITIGATION" : "NEW_GOVT_NOTICE", strength: f.strength, title: f.title, url: f.url, reasons: f.reasons });
    }
  }
  for (const al of alerts) {
    await q("INSERT INTO monitor_alerts (subscription_id, kind, detail) VALUES ($1,$2,$3)", [subscriptionId, al.kind, JSON.stringify(al)]);
    await publish(searchId, "monitor_alert", al);
  }
  await q("UPDATE monitor_subscriptions SET last_run_at = NOW(), last_status = $2, baseline_json = $3 WHERE subscription_id = $1",
    [subscriptionId, alerts.length ? "ALERT" : "CLEAR", JSON.stringify({ urls: [...known] })]);
  await publish(searchId, "monitor_check_completed", { subscriptionId, alerts: alerts.length });
  if (alerts.length) await deliverTenantWebhook(searchId, "monitor.alert", { searchId, alerts });
  return { active: true, alerts: alerts.length };
}

export async function notifyTenant(searchId: string) {
  const s = await searchRow(searchId);
  await deliverTenantWebhook(searchId, "title_search.completed", { searchId, status: s.status, verdict: s.verdict, output: s.output_json, certificateUrl: s.certificate_id ? `${config.PUBLIC_BASE_URL}/api/v1/certificates/${s.certificate_id}.pdf` : null });
}

export async function failSearch(searchId: string, reason: string) {
  await q("UPDATE title_searches SET status = 'FAILED', failure_reason = $2, completed_at = NOW() WHERE search_id = $1", [searchId, reason.slice(0, 2000)]);
  await publish(searchId, "search_failed", { reason });
}
