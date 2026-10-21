import {
  BANK_NOTICE_DOMAINS, COURT_DOMAINS, GOVT_DOMAINS, STATES, extractCase, extractNotice, extractRestriction, findPlace, findSurvey,
  matchPage, normalizeAgentResult,
  type AgentRole, type Finding, type MatchStrength, type PortalCode, type PortalExtraction, type PropertyQuery, type StateDef
} from "@titleshield/core";
import { config } from "../config.ts";
import { one, q } from "../db/pool.ts";
import { publish } from "../events/bus.ts";
import { putImmutable } from "../storage/worm.ts";
import { TinyFishError, tfFetch, tfSearch, type FetchResult, type SearchResult } from "../tinyfish/client.ts";
import { recordedFetch, recordedScenario, recordedSearch } from "../tinyfish/recorded.ts";

/**
 * Web agents on TinyFish's FREE Search + Fetch APIs (PDF §3, adapted to the free tier):
 *   COURTS        judgments / orders naming the owner or the survey number (Indian Kanoon, eCourts, High Court)
 *   BANK_NOTICES  SARFAESI possession / demand / auction notices for the property or owner
 *   GOVT_NOTICES  land-acquisition, prohibited-land and other notifications; RERA projects
 * Each agent: search → rank snippets → fetch the most relevant pages → read them with
 * deterministic extractors → grade each page STRONG / MEDIUM / WEAK against this property.
 */

export type AgentStatus = "SUCCESS" | "NO_RECORD" | "NOT_CONFIGURED" | "RATE_LIMITED" | "FAILED";

export interface AgentOutcome {
  role: AgentRole;
  portalCode: string;
  portalName: string;
  status: AgentStatus;
  extraction: PortalExtraction | null;
  findings: Finding[];
  durationMs: number;
  error: string | null;
  evidenceUri: string | null;
  evidenceSha256: string | null;
}

export interface AgentQuery extends PropertyQuery { locality?: string | null }

interface QuerySpec { q: string; domains?: string[]; why: string }

const RANK: Record<MatchStrength, number> = { STRONG: 3, MEDIUM: 2, WEAK: 1, NONE: 0 };
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const inDomains = (u: string, domains?: string[]) => !domains?.length || domains.some((d) => hostOf(u) === d || hostOf(u).endsWith(`.${d}`));
const short = (domains?: string[]) => (domains?.length ? domains.slice(0, 3).join(", ") + (domains.length > 3 ? " …" : "") : "the web");
const quote = (s: string) => `"${s.replace(/"/g, "")}"`;
const yearsAgo = (iso: string | null) => (iso ? (Date.now() - Date.parse(iso)) / (365.25 * 86400e3) : null);

function placeOf(qy: AgentQuery) { return (qy.village || qy.locality || "").trim(); }

// ---------------- query plans ----------------

function plan(role: AgentRole, qy: AgentQuery, st: StateDef): QuerySpec[] {
  const owner = qy.claimedOwnerName?.trim(), survey = qy.surveyNumber?.trim(), place = placeOf(qy), district = qy.district?.trim();
  const courts = [...COURT_DOMAINS, st.highCourt.domain];
  const out: QuerySpec[] = [];
  if (role === "COURTS") {
    if (owner) out.push({ q: `${quote(owner)} ${place} ${district} suit property`, domains: courts, why: "cases naming the owner" });
    if (survey && place) out.push({ q: `${quote(`survey no ${survey}`)} ${quote(place)}`, domains: courts, why: "cases about this survey number" });
    if (owner && !survey) out.push({ q: `${quote(owner)} ${district} injunction partition declaration`, domains: courts, why: "civil suits by owner name" });
  }
  if (role === "BANK_NOTICES") {
    if (survey && place) out.push({ q: `${quote(survey)} ${quote(place)} possession notice SARFAESI`, why: "SARFAESI notices for this survey number" });
    if (owner) out.push({ q: `${quote(owner)} possession notice SARFAESI ${district}`, why: "notices naming the owner as borrower" });
    if (place) out.push({ q: `${place} ${district} bank auction property ${survey ?? ""}`.trim(), domains: BANK_NOTICE_DOMAINS, why: "bank auction listings in this locality" });
  }
  if (role === "GOVT_NOTICES") {
    if (place) out.push({ q: `${quote(place)} ${district} land acquisition notification`, domains: GOVT_DOMAINS, why: "land acquisition notifications" });
    if (survey && place) out.push({ q: `${quote(`survey no ${survey}`)} ${quote(place)} notification`, domains: GOVT_DOMAINS, why: "notifications naming this survey number" });
    if (place) out.push({ q: `${place} ${district} RERA registered project`, domains: st.rera ? [hostOf(st.rera.url)] : undefined, why: "RERA-registered projects at this location" });
  }
  return out;
}

const ROLE_META: Record<Exclude<AgentRole, "RECORDS">, { code: PortalCode; name: string; purpose: string }> = {
  COURTS: { code: "WEB_COURT_RECORDS", name: "Court records (Indian Kanoon, eCourts, High Court)", purpose: "Find court cases about a specific land parcel or its owner for a property title check in India." },
  BANK_NOTICES: { code: "WEB_BANK_NOTICES", name: "Bank notices (SARFAESI possession & auction)", purpose: "Find bank SARFAESI possession, demand or auction notices for a specific property in India." },
  GOVT_NOTICES: { code: "WEB_GOVT_NOTICES", name: "Government notifications & RERA", purpose: "Find land acquisition, prohibited-land notifications or RERA registration for a specific property in India." }
};

// ---------------- page analysis ----------------

interface Analysis { finding: Finding | null; litigation?: PortalExtraction["litigationCases"][number]; encumbrance?: PortalExtraction["encumbrances"][number]; restriction?: string }

function analyse(role: AgentRole, page: FetchResult, qy: AgentQuery): Analysis {
  const text = `${page.title ?? ""}\n${page.text ?? ""}`;
  const ctx = { survey: qy.surveyNumber, village: qy.village, locality: qy.locality, district: qy.district, owner: qy.claimedOwnerName };
  const m = matchPage(text, ctx);
  const base = { title: page.title?.slice(0, 200) || page.url, url: page.final_url || page.url, snippet: (m.surveyExcerpt ?? m.placeExcerpt ?? (page.description || text.slice(0, 240))).slice(0, 400) };

  if (role === "COURTS") {
    if (m.strength === "NONE") return { finding: null };
    const info = extractCase(page.text ?? "", page.title ?? "", base.url);
    const finding: Finding = { kind: "COURT_CASE", strength: m.strength as Finding["strength"], ...base, title: info.petitioner !== "Not stated" ? `${info.petitioner} v. ${info.respondent}` : base.title, reasons: [...m.reasons, info.status], detail: { ...info } };
    if (m.strength !== "STRONG") return { finding };
    return {
      finding,
      litigation: {
        cnrNumber: info.cnrNumber, caseType: info.caseType, filingDate: info.date ?? "", courtName: info.court,
        petitioner: info.petitioner, respondent: info.respondent, currentStatus: info.status,
        hasStayOrInjunction: info.stay, disposalDate: info.disposed ? info.date : null, matchedBy: "SURVEY_NUMBER"
      }
    };
  }

  if (role === "BANK_NOTICES") {
    if (m.strength === "NONE") return { finding: null };
    const isNotice = /possession notice|sarfaesi|13\s*\(\s*[24]\s*\)|secured creditor|auction|demand notice|mortgaged/i.test(text);
    const info = extractNotice(page.text ?? "");
    let strength = m.strength as Finding["strength"];
    const reasons = [...m.reasons, info.kind];
    if (!isNotice) { strength = "WEAK"; reasons.push("page is not a bank notice"); }
    const age = yearsAgo(info.date);
    if (strength === "STRONG" && age !== null && age > 10) { strength = "MEDIUM"; reasons.push(`notice is ${Math.floor(age)} years old — check whether the loan was closed`); }
    const finding: Finding = { kind: isNotice ? "BANK_NOTICE" : "OTHER", strength, ...base, title: isNotice ? `${info.kind}${info.lender ? ` · ${info.lender}` : ""}` : base.title, reasons, detail: { ...info } };
    if (strength !== "STRONG") return { finding };
    return {
      finding,
      encumbrance: {
        documentNumber: `${hostOf(base.url)}${info.date ? ` ${info.date}` : ""}`, registrationDate: info.date ?? new Date().toISOString().slice(0, 10),
        transactionNature: info.kind, executant: info.borrower, claimant: info.lender, lenderOrClaimantName: info.lender ?? "Unnamed secured creditor",
        loanReference: null, isActiveLien: true, loanAmountINR: info.amountINR
      }
    };
  }

  // GOVT_NOTICES
  const survey = qy.surveyNumber ? findSurvey(text, qy.surveyNumber) : { found: false, withKeyword: false, excerpt: null };
  const place = findPlace(text, qy.village || qy.locality);
  const r = extractRestriction(page.text ?? "");
  if (/rera/i.test(text) && /(registration (?:no|number)|project)/i.test(text) && place.found) {
    const proj = (text.match(/(?:project name|name of (?:the )?project)\s*[:\-]?\s*([^\n|]{3,80})/i) ?? [])[1]?.trim();
    const reg = (text.match(/\b(PR\/[A-Z0-9\/\-]+|P\d{11}|[A-Z]{2,4}RERA[A-Z0-9\/\-]+)\b/) ?? [])[1];
    return { finding: { kind: "RERA_PROJECT", strength: "WEAK", ...base, title: proj ? `RERA project: ${proj}` : base.title, reasons: [`${placeOf(qy)} mentioned on a RERA page`, ...(reg ? [`registration ${reg}`] : [])], detail: { project: proj ?? null, registration: reg ?? null } } };
  }
  if (!r || !place.found) return { finding: m.strength === "NONE" ? null : { kind: "OTHER", strength: "WEAK", ...base, reasons: m.reasons } };
  const strength: Finding["strength"] = survey.withKeyword ? "STRONG" : "MEDIUM";
  const reasons = [`${r.kind} mentioned`, `${placeOf(qy)} mentioned`, ...(survey.withKeyword ? [`survey no. ${qy.surveyNumber} mentioned`] : ["survey number not on the page — may cover other parcels"])];
  const finding: Finding = { kind: "GOVT_RESTRICTION", strength, ...base, title: `Notification: ${r.kind}`, snippet: r.sentence, reasons };
  return strength === "STRONG" ? { finding, restriction: `${r.sentence} [source: ${base.url}]` } : { finding };
}

// ---------------- runner ----------------

export async function runWebAgent(searchId: string, role: Exclude<AgentRole, "RECORDS">, qy: AgentQuery, opts: { fresh?: boolean } = {}): Promise<AgentOutcome> {
  const st = STATES[qy.stateCode];
  const meta = ROLE_META[role];
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  // Walkthrough properties (demo/README.md) replay recorded TinyFish responses; everything else is live.
  const recorded = recordedScenario(qy);
  const search: typeof tfSearch = recorded ? (p) => recordedSearch(recorded, role, p.query, qy, p.includeDomains) : tfSearch;
  const fetchPages: typeof tfFetch = recorded ? (urls) => recordedFetch(recorded, urls, qy) : tfFetch;
  const run = await one<{ run_id: string }>(
    `INSERT INTO tinyfish_agent_runs (search_id, portal_code, goal_prompt_version, status, agent_role, mode) VALUES ($1,$2,'FREE_SEARCH_FETCH_V1','STREAMING',$3,$4) RETURNING run_id`,
    [searchId, meta.code, role, recorded ? "recorded" : "live"]);
  const say = (step: string, extra: object = {}) => publish(searchId, "tinyfish_progress", { portal: meta.code, role, step, elapsedMs: elapsed(), ...extra });
  await publish(searchId, "tinyfish_started", { portal: meta.code, role, name: meta.name, mode: "live" });
  const waitNote = (ms: number) => say(`Waiting ${Math.ceil(ms / 1000)} s for TinyFish's free-tier limit (30 searches / 150 pages a minute)`, { waiting: true });

  const queries = plan(role, qy, st);
  const sourceLog: NonNullable<PortalExtraction["sourceLog"]> = [];
  const candidates: Array<SearchResult & { rank: number }> = [];
  let status: AgentStatus = "SUCCESS", error: string | null = null;

  if (!queries.length) {
    status = "NO_RECORD";
    error = role === "COURTS" ? "Add the owner's name or survey number to search court records" : "Add the village / locality to search notices";
    await say(error);
  }

  for (const spec of queries) {
    try {
      await say(`Searching ${short(spec.domains)} for ${spec.q}`, { query: spec.q, why: spec.why });
      const r = await search({ query: spec.q, purpose: meta.purpose, includeDomains: spec.domains }, { fresh: opts.fresh, onWait: waitNote });
      const kept = r.results.filter((x) => inDomains(x.url, spec.domains));
      sourceLog.push({ query: spec.q, domains: spec.domains ?? [], results: kept.length, cached: r.cached, urls: kept.slice(0, 10).map((x) => ({ url: x.url, title: x.title })) });
      for (const x of kept) {
        const rank = RANK[matchPage(`${x.title}\n${x.snippet}`, { survey: qy.surveyNumber, village: qy.village, locality: qy.locality, district: qy.district, owner: qy.claimedOwnerName }).strength];
        if (!candidates.some((c) => c.url === x.url)) candidates.push({ ...x, rank });
      }
      await say(`${kept.length} result${kept.length === 1 ? "" : "s"}${r.cached ? " (cached)" : ""} — ${spec.why}`, { results: kept.slice(0, 5).map((x) => ({ title: x.title, url: x.url })) });
    } catch (e) {
      const te = e as TinyFishError;
      error = te.message;
      if (te.code === "NOT_CONFIGURED" || te.code === "INVALID_KEY") { status = "NOT_CONFIGURED"; await say(te.message); break; }
      if (te.code === "RATE_LIMITED" || te.code === "QUOTA") { status = "RATE_LIMITED"; await say(te.message); break; }
      await say(`Search failed: ${te.message}`);
    }
  }

  // Read the most relevant pages: anything whose snippet already matches, topped up with the best-ranked rest.
  const findings: Finding[] = [];
  const litigationCases: PortalExtraction["litigationCases"] = [];
  const encumbrances: PortalExtraction["encumbrances"] = [];
  const restrictions: string[] = [];
  const pagesRead: Array<{ url: string; title?: string; excerpt: string }> = [];
  if (status === "SUCCESS" && candidates.length) {
    const ranked = candidates.sort((a, b) => b.rank - a.rank || a.position - b.position);
    const pick = [...ranked.filter((c) => c.rank > 0), ...ranked.filter((c) => c.rank === 0)].slice(0, Math.max(1, Math.min(config.PAGES_PER_AGENT, ranked.filter((c) => c.rank > 0).length + 2)));
    try {
      await say(`Reading ${pick.length} page${pick.length === 1 ? "" : "s"} with TinyFish Fetch`);
      const f = await fetchPages(pick.map((p) => p.url), meta.purpose, { fresh: opts.fresh, onWait: waitNote });
      for (const page of f.results) {
        pagesRead.push({ url: page.url, title: page.title, excerpt: (page.text ?? "").slice(0, 20_000) });
        const a = analyse(role, page, qy);
        if (!a.finding) continue;
        findings.push(a.finding);
        if (a.litigation) litigationCases.push(a.litigation);
        if (a.encumbrance) encumbrances.push(a.encumbrance);
        if (a.restriction) restrictions.push(a.restriction);
        if (a.finding.strength !== "WEAK") await say(`${a.finding.strength === "STRONG" ? "Match" : "Possible match"}: ${a.finding.title}`, { finding: { strength: a.finding.strength, url: a.finding.url } });
      }
      if (f.errors.length) await say(`${f.errors.length} page${f.errors.length === 1 ? "" : "s"} could not be read (${[...new Set(f.errors.map((e) => e.error))].join(", ")})`);
    } catch (e) {
      const te = e as TinyFishError;
      error = te.message;
      status = te.code === "RATE_LIMITED" || te.code === "QUOTA" ? "RATE_LIMITED" : te.code === "NOT_CONFIGURED" || te.code === "INVALID_KEY" ? "NOT_CONFIGURED" : "FAILED";
      await say(`Reading pages failed: ${te.message}`);
    }
  }
  const strong = findings.filter((f) => f.strength === "STRONG").length, medium = findings.filter((f) => f.strength === "MEDIUM").length;
  if (status === "SUCCESS") await say(strong ? `${strong} confirmed match${strong > 1 ? "es" : ""} for this property` : medium ? `${medium} possible match${medium > 1 ? "es" : ""} need checking` : "No matching records for this property", { summary: true });

  const extraction = status === "SUCCESS" || status === "NO_RECORD"
    ? normalizeAgentResult(meta.code, {
        portalStatus: "OK", surveyNumberMatched: qy.surveyNumber ?? "", currentOwnerNames: [], mutationHistory: [],
        encumbrances, litigationCases, otherRightsAndLiabilities: restrictions, findings, sourceLog,
        rawArtifactUrls: findings.map((f) => f.url)
      }, qy.surveyNumber ?? "")
    : null;

  let evidenceUri: string | null = null, evidenceSha256: string | null = null;
  try {
    const stored = await putImmutable(`searches/${searchId}/agents/${meta.code}-${run!.run_id}.json`,
      Buffer.from(JSON.stringify({ agent: meta, tinyfish: { products: ["search", "fetch"], tier: "free", source: recorded ? `recorded responses (${recorded.id})` : "live API" }, query: qy, sourceLog, pagesRead, findings, status, error, at: new Date().toISOString() }, null, 2)), "application/json");
    evidenceUri = stored.uri; evidenceSha256 = stored.sha256;
  } catch (e) { console.error("evidence write failed", e); }

  await q(`UPDATE tinyfish_agent_runs SET status = $2, extracted_json = $3, raw_sse_log_s3_uri = $4, error = $5, search_log = $6, finished_at = NOW() WHERE run_id = $1`,
    [run!.run_id, status, extraction ? JSON.stringify(extraction) : null, evidenceUri, error, JSON.stringify(sourceLog)]);
  await publish(searchId, "tinyfish_agent_completed", {
    portal: meta.code, role, status, elapsedMs: elapsed(), error,
    counts: { searches: sourceLog.length, results: sourceLog.reduce((n, s) => n + s.results, 0), pages: pagesRead.length, strong, medium, weak: findings.length - strong - medium }
  });
  return { role, portalCode: meta.code, portalName: meta.name, status, extraction, findings, durationMs: elapsed(), error, evidenceUri, evidenceSha256 };
}

/** Is each official state portal reachable right now? (TinyFish Fetch, free.) Also finds a portal where none is registered. */
export async function checkPortals(st: StateDef, opts: { recorded?: boolean } = {}): Promise<Array<{ role: string; name: string; url: string; reachable: boolean | null; note: string }>> {
  const out: Array<{ role: string; name: string; url: string; reachable: boolean | null; note: string }> = [];
  if (opts.recorded) {
    for (const x of [{ role: "Record of Rights", p: st.revenue }, { role: "Encumbrance Certificate", p: st.encumbrance }]) if (x.p) out.push({ role: x.role, name: x.p.name, url: x.p.url, reachable: true, note: "online" });
    return out;
  }
  const list = [{ role: "Record of Rights", p: st.revenue }, { role: "Encumbrance Certificate", p: st.encumbrance }];
  for (const x of list) {
    if (x.p) { out.push({ role: x.role, name: x.p.name, url: x.p.url, reachable: null, note: "" }); continue; }
    try {
      const r = await tfSearch({ query: `${st.name} ${x.role === "Record of Rights" ? "land records record of rights" : "encumbrance certificate registration"} official portal`, includeDomains: ["gov.in", "nic.in"] });
      const hit = r.results.find((h) => /gov\.in|nic\.in/.test(hostOf(h.url)));
      if (hit) out.push({ role: x.role, name: hit.title.slice(0, 80), url: hit.url, reachable: null, note: "found by TinyFish Search" });
    } catch { /* leave missing */ }
  }
  if (out.length) {
    try {
      const f = await tfFetch(out.map((o) => o.url), "Check whether a government land-records portal is online.");
      for (const o of out) {
        const ok = f.results.find((r) => r.url === o.url || r.final_url === o.url);
        const err = f.errors.find((e) => e.url === o.url);
        o.reachable = ok ? true : err ? false : null;
        o.note = ok ? (o.note || "online") : err ? `unreachable (${err.error}${err.status ? ` ${err.status}` : ""})` : o.note;
      }
    } catch (e) { for (const o of out) o.note = o.note || `not checked: ${(e as Error).message}`; }
  }
  return out;
}
