/**
 * End-to-end against a real PostgreSQL. External services (TinyFish Search/Fetch,
 * OpenStreetMap, India Post, Gemini) are served by test/mockServices.ts using their
 * published response formats, so every production code path runs unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import type http from "node:http";
import type { FastifyInstance } from "fastify";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { GEMINI_KEY, TF_KEY, startMocks, state as mock } from "./mockServices.ts";

const BASE = "http://localhost:8091/api/v1";
let app: FastifyInstance;
let mocks: http.Server;
let buyer = "", advocate = "", admin = "", bankKey = "";
let dbOk = true;

async function api(path: string, opts: { method?: string; token?: string; apiKey?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}), ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const login = async (email: string) => (await api("/auth/login", { body: { email, password: "demo1234" } })).json.token as string;

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  let last: T;
  do { last = await fn(); if (ok(last)) return last; await new Promise((r) => setTimeout(r, 300)); } while (Date.now() < end);
  throw new Error(`timeout; last value ${JSON.stringify(last!).slice(0, 600)}`);
}
const searchDone = (token: string, id: string) => waitFor(() => api(`/title-search/${id}`, { token }).then((r) => r.json), (s: any) => ["COMPLETED", "FAILED", "MANUAL_REVIEW"].includes(s.status));
const escrowState = (token: string, id: string, states: string[]) => waitFor(() => api(`/escrow/${id}`, { token }).then((r) => r.json), (e: any) => states.includes(e.escrow_state));

async function pdf(lines: string[]) {
  const d = await PDFDocument.create();
  const p = d.addPage([595, 842]);
  const f = await d.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => p.drawText(l, { x: 36, y: 800 - i * 14, size: 9, font: f }));
  return Buffer.from(await d.save());
}
async function upload(token: string, searchId: string, kind: string, name: string, buf: Buffer, type = "application/pdf") {
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", new Blob([new Uint8Array(buf)], { type }), name);
  const r = await fetch(`${BASE}/title-search/${searchId}/documents`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: fd });
  return { status: r.status, json: await r.json() };
}

// Digital EC + RoR text for Hebbal 42/2B (read without any AI from the PDF text layer)
const HEBBAL_EC = [
  "ENCUMBRANCE CERTIFICATE - Sub-Registrar, Hebbal. Survey No. 42/2B, Hebbal village",
  "Search period from 01-01-1990 to 20-10-2026",
  "1. Document No 1874/2003 Date 14-03-2003 Nature: Sale Deed",
  "   Executant: Hanumanthappa Claimant: Lakshmamma R Consideration Rs. 9,00,000",
  "2. Document No 3356/2019 Date 05-09-2019 Nature: Sale Deed",
  "   Executant: Lakshmamma R Claimant: Venkatesh Murthy Consideration Rs. 92,00,000",
  "3. Document No 5102/2020 Date 18-02-2020 Nature: Mortgage by deposit of title deeds",
  "   Executant: Venkatesh Murthy Claimant: Canara Bank Loan No HL-20418 Rs. 40,00,000",
  "4. Document No 1167/2024 Date 30-01-2024 Nature: Release deed",
  "   Executant: Canara Bank Claimant: Venkatesh Murthy Loan No HL-20418"
];
const HEBBAL_ROR = ["RECORD OF RIGHTS (RTC) - Survey No. 42/2B, Hebbal", "Owner Name: Venkatesh Murthy", "Extent: 1 acre 12 guntas", "Other rights: Canara Bank loan closed 2024"];

const PROPS = {
  HEBBAL: { addressText: "Sy. No. 42/2B, Hebbal, Bengaluru North, Bengaluru Urban, Karnataka 560024", claimedOwnerName: "Venkatesh Murthy", surveyNumber: "42/2B" },
  WHITEFIELD: { addressText: "Flat 302, Prestige Shantiniketan, Whitefield, Bengaluru 560048", claimedOwnerName: "Anita Desai" },
  KONDLI: { addressText: "Khasra 312, Kondli Bangar, Dadri, Gautam Buddha Nagar, Uttar Pradesh", claimedOwnerName: "Ramesh Kumar Sharma", surveyNumber: "312" },
  NAVULURU: { addressText: "Navuluru, Mangalagiri, Guntur, Andhra Pradesh", claimedOwnerName: "Srinivasa Reddy", surveyNumber: "78/3" },
  CHANDAPURA: { addressText: "Chandapura, Anekal, Bengaluru Urban, Karnataka", claimedOwnerName: "Muniyappa", surveyNumber: "118/4" }
};

beforeAll(async () => {
  try { const { pool } = await import("../src/db/pool.ts"); await pool.query("SELECT 1"); } catch { dbOk = false; return; }
  mocks = await startMocks(8093);
  const { migrate } = await import("../src/db/migrate.ts");
  await migrate(() => {});
  const { q } = await import("../src/db/pool.ts");
  await q("DELETE FROM app_settings"); await q("DELETE FROM web_cache"); await q("DELETE FROM tinyfish_usage");
  const { ensurePki } = await import("../src/crypto/pki.ts");
  ensurePki(() => {});
  const { startEmbeddedChain } = await import("../src/chain/chain.ts");
  await startEmbeddedChain(() => {});
  const { buildApp } = await import("../src/app.ts");
  app = await buildApp();
  await app.listen({ port: 8091, host: "127.0.0.1" });
  buyer = await login("buyer@demo.in"); advocate = await login("advocate@demo.in"); admin = await login("admin@demo.in");
  bankKey = (await api("/meta")).json.demoBankApiKey;
});

afterAll(async () => {
  await app?.close();
  mocks?.close();
  const { closeBus } = await import("../src/events/bus.ts");
  await closeBus();
  const { stopEmbeddedChain } = await import("../src/chain/chain.ts");
  await stopEmbeddedChain();
});

describe("setup: free keys", () => {
  it("without a TinyFish key every web check reports it and the title cannot auto-clear", async () => {
    if (!dbOk) return;
    expect((await api("/meta")).json.tinyfish.configured).toBe(false);
    const r = await api("/title-search/execute", { token: buyer, body: { ...PROPS.HEBBAL, streamProgress: false } });
    expect(r.status).toBe(202);
    const s = await searchDone(buyer, r.json.searchId);
    expect(s.agentRuns.filter((x: any) => x.agent_role !== "RECORDS").every((x: any) => x.status === "NOT_CONFIGURED")).toBe(true);
    expect(s.verdict).toBe("CONDITIONAL_REVIEW");
    expect(s.assessment.rules.find((x: any) => x.id === "G3").detail).toMatch(/TinyFish key missing/);
  });

  it("saves keys from the Settings page and tests them against the services", async () => {
    if (!dbOk) return;
    expect((await api("/settings", { method: "PUT", token: buyer, body: { tinyfishApiKey: "wrong-key" } })).status).toBe(200); // first-run: any signed-in user
    const bad = await api("/settings/test", { token: buyer, body: { service: "tinyfish" } });
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toMatch(/rejected the API key/);
    expect((await api("/settings", { method: "PUT", token: buyer, body: { tinyfishApiKey: TF_KEY } })).status).toBe(403); // now admin only
    await api("/settings", { method: "PUT", token: admin, body: { tinyfishApiKey: TF_KEY, geminiApiKey: "" } });
    const good = await api("/settings/test", { token: admin, body: { service: "tinyfish" } });
    expect(good.json).toMatchObject({ ok: true });
    expect(good.json.results).toBeGreaterThan(0);
    const s = (await api("/settings", { token: admin })).json;
    expect(s.tinyfish).toMatchObject({ configured: true, source: "app", masked: "••••_123" });
  });
});

describe("any address, free TinyFish agents", () => {
  it("resolves a plain flat address and grades a name-only court hit as MEDIUM (review)", async () => {
    if (!dbOk) return;
    const sug = await api(`/geo/suggest?q=${encodeURIComponent("Whitefield Bengaluru")}`);
    expect(sug.json[0]).toMatchObject({ stateCode: "KA" });
    const r = await api("/title-search/execute", { token: buyer, body: { ...PROPS.WHITEFIELD, streamProgress: false } });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    const s = await searchDone(buyer, r.json.searchId);
    expect(s).toMatchObject({ state_code: "KA", district_name: "Bengaluru Urban", pincode: "560048" });
    expect(s.location_json.taluk).toBe("Bangalore East");
    expect(s.location_json.sources.join(" ")).toMatch(/OpenStreetMap/);
    expect(s.location_json.sources).toContain("India Post (PIN code)");
    const courts = s.agentRuns.find((x: any) => x.agent_role === "COURTS");
    expect(courts.status).toBe("SUCCESS");
    expect(courts.extracted_json.findings[0]).toMatchObject({ kind: "COURT_CASE", strength: "MEDIUM", url: "https://indiankanoon.org/doc/445566/" });
    expect(courts.search_log.length).toBeGreaterThan(0);
    expect(s.verdict).toBe("CONDITIONAL_REVIEW");
    const hits = s.assessment.rules.filter((x: any) => x.hit).map((x: any) => x.id);
    expect(hits).toEqual(expect.arrayContaining(["G3", "G5"]));
  });

  it("finds a SARFAESI possession notice for the survey number → veto V1, defect report", async () => {
    if (!dbOk) return;
    const r = await api("/title-search/execute", { token: buyer, body: { ...PROPS.KONDLI, streamProgress: false } });
    const s = await searchDone(buyer, r.json.searchId);
    expect(s.verdict).toBe("REJECTED");
    expect(s.encumbrance_clearance_score).toBe(0);
    expect(s.assessment.liens.find((l: any) => !l.released)).toMatchObject({ lender: "HDFC BANK", amountINR: 4800000 });
    expect(s.certificate_id).toMatch(/^TDR-UP-/);
  });

  it("finds a partition suit with an injunction on the survey number → veto V2", async () => {
    if (!dbOk) return;
    const r = await api("/title-search/execute", { token: buyer, body: { ...PROPS.NAVULURU, streamProgress: false } });
    const s = await searchDone(buyer, r.json.searchId);
    expect(s.assessment.rules.find((x: any) => x.id === "V2").hit).toBe(true);
    expect(s.verdict).toBe("REJECTED");
  });

  it("finds a land-acquisition notification for the survey number → veto V3", async () => {
    if (!dbOk) return;
    const r = await api("/title-search/execute", { token: buyer, body: { ...PROPS.CHANDAPURA, streamProgress: false } });
    const s = await searchDone(buyer, r.json.searchId);
    expect(s.assessment.rules.find((x: any) => x.id === "V3").hit).toBe(true);
    expect(s.verdict).toBe("REJECTED");
  });

  it("with EC + RoR uploaded (read from the PDF text, no AI) and clean web checks → clean certificate", async () => {
    if (!dbOk) return;
    const r = await api("/title-search/execute", { token: buyer, body: { ...PROPS.HEBBAL, streamProgress: false, startImmediately: false } });
    expect(r.json.status).toBe("AWAITING_DOCUMENTS");
    expect((await upload(buyer, r.json.searchId, "EC", "hebbal-ec.pdf", await pdf(HEBBAL_EC))).status).toBe(200);
    expect((await upload(buyer, r.json.searchId, "ROR", "hebbal-rtc.pdf", await pdf(HEBBAL_ROR))).status).toBe(200);
    await api(`/title-search/${r.json.searchId}/start`, { token: buyer, body: {} });
    const s = await searchDone(buyer, r.json.searchId);
    expect(s.documents.every((d: any) => d.status === "EXTRACTED")).toBe(true);
    expect(s.assessment.liens).toEqual([expect.objectContaining({ lender: "CANARA BANK", released: true })]);
    expect(s.verdict, JSON.stringify(s.assessment.rules.filter((x: any) => x.hit))).toBe("CLEAN_TITLE");
    expect(s.encumbrance_clearance_score).toBe(100);
    expect(s.certificate_id).toMatch(/^TCC-KA-/);
  });

  it("streams the run as Server-Sent Events, including the resolved location", async () => {
    if (!dbOk) return;
    const res = await fetch(`${BASE}/title-search/execute`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${buyer}` }, body: JSON.stringify(PROPS.KONDLI) });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    for (const ev of ["accepted", "agent_spawned", "location_resolved", "tinyfish_progress", "tinyfish_agent_completed", "ocr_completed", "title_scored", "title_clearance_result"]) expect(text).toContain(`event: ${ev}`);
  });

  it("reads uploaded records with Gemini when a free key is saved (Kannada names matched)", async () => {
    if (!dbOk) return;
    await api("/settings", { method: "PUT", token: admin, body: { geminiApiKey: GEMINI_KEY } });
    expect((await api("/settings/test", { token: admin, body: { service: "gemini" } })).json).toMatchObject({ ok: true, reply: "OK" });
    const r = await api("/title-search/execute", { token: buyer, body: { ...PROPS.HEBBAL, streamProgress: false, startImmediately: false } });
    await upload(buyer, r.json.searchId, "EC", "ec-scan.png", Buffer.from("fake image bytes"), "image/png");
    await upload(buyer, r.json.searchId, "ROR", "rtc-scan.png", Buffer.from("fake image bytes"), "image/png");
    const before = mock.calls.gemini;
    await api(`/title-search/${r.json.searchId}/start`, { token: buyer, body: {} });
    const s = await searchDone(buyer, r.json.searchId);
    expect(mock.calls.gemini - before).toBe(2);
    expect(s.assessment.lastOwnerName).toBe("Venkatesh Murthy S/O Narayana Murthy");
    expect(s.assessment.ownerMatch.kind).not.toBe("mismatch");
    expect(s.verdict).toBe("CLEAN_TITLE");
    await api("/settings", { method: "PUT", token: admin, body: { geminiApiKey: "" } });
  });

  it("caches web results so a repeat search spends no free quota", async () => {
    if (!dbOk) return;
    const before = { ...mock.calls };
    const r = await api("/title-search/execute", { token: buyer, body: { ...PROPS.KONDLI, streamProgress: false } });
    await searchDone(buyer, r.json.searchId);
    if (mock.calls.search !== before.search) console.log("UNCACHED", mock.log.slice(-(mock.calls.search - before.search)));
    expect(mock.calls.search).toBe(before.search);
    expect(mock.calls.fetch).toBe(before.fetch);
    const meta = (await api("/meta")).json;
    expect(meta.tinyfish.usage.search.used).toBeGreaterThan(0);
  });
  it("validates search results before Fetch (no private, local or duplicate URLs) and marks a check INCOMPLETE when a relevant page can't be read", async () => {
    if (!dbOk) return;
    const r = await api("/title-search/execute", { token: buyer, body: { addressText: "Baner, Pune", claimedOwnerName: "Sunil Gokhale", surveyNumber: "55", streamProgress: false } });
    const s = await searchDone(buyer, r.json.searchId);
    const bank = s.agentRuns.find((x: any) => x.agent_role === "BANK_NOTICES");
    const rejected = bank.search_log.flatMap((l: any) => l.rejected ?? []).map((x: any) => x.reason);
    expect(rejected).toEqual(expect.arrayContaining(["private IP address", "local hostname", "duplicate"]));
    expect(bank.status).toBe("INCOMPLETE");
    expect(bank.error).toMatch(/could (not )?be read/);
    expect(mock.log.some((l) => l.includes("10.0.0.5"))).toBe(false);
    expect(s.verdict).not.toBe("CLEAN_TITLE");
    expect(s.assessment.rules.find((x: any) => x.id === "G3").detail).toMatch(/incomplete/);
  });

  it("Fetch requests contain only documented fields; diagnostics run Search, Fetch and Search→Fetch", async () => {
    if (!dbOk) return;
    const d = (await api("/settings/diagnostics", { token: admin, body: {} })).json;
    expect(d.steps.map((x: any) => x.ok)).toEqual([true, true, true]);
    expect(d.usage.credits.budget).toBe(8000);
    expect(d.usage.credits.used).toBeGreaterThan(0);
  });

  it("stops calling TinyFish when the credit budget is used up and reports the check as incomplete", async () => {
    if (!dbOk) return;
    const { q } = await import("../src/db/pool.ts");
    await q("INSERT INTO tinyfish_usage (day, kind, units) VALUES ('2000-01-01', 'search', 100000) ON CONFLICT (day, kind) DO UPDATE SET units = 100000");
    const before = mock.calls.search;
    const r = await api("/title-search/execute", { token: buyer, body: { addressText: "Baner, Pune", claimedOwnerName: "Budget Test Owner", surveyNumber: "77", streamProgress: false } });
    const s = await searchDone(buyer, r.json.searchId);
    await q("DELETE FROM tinyfish_usage WHERE day = '2000-01-01'");
    expect(mock.calls.search).toBe(before);
    const web = s.agentRuns.filter((x: any) => x.agent_role !== "RECORDS");
    expect(web.every((x: any) => x.status === "INCOMPLETE" && /budget/i.test(x.error))).toBe(true);
    expect(s.verdict).not.toBe("CLEAN_TITLE");
  });
});

describe("bank API", () => {
  it("X-API-Key → 202, idempotent retries, signed webhook", async () => {
    if (!dbOk) return;
    const key = crypto.randomUUID();
    const body = { ...PROPS.KONDLI, clientReference: "LOAN-APP-1" };
    const a = await api("/title-search/execute", { apiKey: bankKey, body, headers: { "idempotency-key": key } });
    expect(a.status).toBe(202);
    expect((await api("/title-search/execute", { apiKey: bankKey, body, headers: { "idempotency-key": key } })).json.searchId).toBe(a.json.searchId);
    expect((await api("/title-search/execute", { apiKey: "wrong", body })).status).toBe(401);
    await searchDone(admin, a.json.searchId);
    const sink = await waitFor(() => api("/dev/webhook-sink").then((r) => r.json), (s: any[]) => s.some((x) => x.body?.data?.searchId === a.json.searchId));
    expect(sink.find((x: any) => x.body?.data?.searchId === a.json.searchId).headers.signature).toMatch(/^[0-9a-f]{64}$/);
  });
});

async function newEscrow(prop: any, sellerName: string, value = 12_500_000, extra: Record<string, unknown> = {}) {
  const e = await api("/escrow", { token: buyer, body: {
    property: { addressText: prop.addressText, surveyNumber: prop.surveyNumber }, propertyValueINR: value, consentAccepted: true,
    buyer: { name: "Ananya Rao", accountNumber: "50100234567891", ifsc: "HDFC0001234" },
    seller: { name: sellerName, accountNumber: "30987654321", ifsc: "SBIN0004567" }, ...extra
  } });
  expect(e.status, JSON.stringify(e.json)).toBe(201);
  for (const party of ["buyer", "seller"]) {
    const s = await api(`/escrow/${e.json.escrow_id}/esign/${party}/start`, { token: buyer, body: { aadhaarLast4: "4821" } });
    expect((await api(`/escrow/${e.json.escrow_id}/esign/${party}/verify`, { token: buyer, body: { esignId: s.json.esignId, otp: "000000" } })).status).toBe(401);
    expect((await api(`/escrow/${e.json.escrow_id}/esign/${party}/verify`, { token: buyer, body: { esignId: s.json.esignId, otp: s.json.sandboxOtp } })).status).toBe(200);
  }
  return e.json;
}
const FINAL = ["RELEASED_TO_SELLER", "REFUNDED_TO_BUYER", "DISPUTE_HOLD"];
const chainView = (id: string) => api(`/escrow/${id}/chain`, { token: buyer }).then((r) => r.json);
const WALK_A = { addressText: "Chandivali, Andheri East, Mumbai 400072", surveyNumber: "28/4" };
const WALK_B = { addressText: "Kandivali West, Mumbai 400067", surveyNumber: "112/7" };

describe("smart-contract escrow: Search → Fetch → verification → signed verdict → contract", () => {
  it("committed contract artifacts are exactly what the Solidity source compiles to", async () => {
    const { compileContracts } = await import("../src/chain/compile.ts");
    const fresh = await compileContracts();
    const fs = await import("node:fs");
    const committed = JSON.parse(fs.readFileSync(new URL("../src/chain/artifacts.json", import.meta.url), "utf8"));
    expect(committed.TitleEscrow.bytecode).toBe(fresh.TitleEscrow.bytecode);
    expect(committed.TestToken.bytecode).toBe(fresh.TestToken.bytecode);
  });

  it("Scenario A — clean under the configured checks: buyer deposits test tokens, signed clean verdict releases them to the seller", async () => {
    if (!dbOk) return;
    const { DEMO_EC, DEMO_ROR, textPdf } = await import("../scripts/make-demo-docs.ts");
    const e = await newEscrow(WALK_A, "Vihaan Rajadhyaksha", 12_000_000);
    expect(e).toMatchObject({ state_code: "MH", advance_deposit_amount_inr: 1_200_000 });
    expect(await chainView(e.escrow_id)).toMatchObject({ onChain: true, status: "Created", amount: 1_200_000, fee: 3000 });
    expect((await api(`/escrow/${e.escrow_id}/deposit`, { token: buyer, body: { mode: "RTGS" } })).status).toBe(409); // bank rail is off when the contract is on
    await upload(buyer, e.search_id, "EC", "ec.pdf", await textPdf(DEMO_EC, "specimen"));
    await upload(buyer, e.search_id, "ROR", "property-card.pdf", await textPdf(DEMO_ROR, "specimen"));
    const dep = await api(`/escrow/${e.escrow_id}/deposit`, { token: buyer, body: { mode: "CHAIN" } });
    expect(dep.status, JSON.stringify(dep.json)).toBe(200);
    const done = await escrowState(buyer, e.escrow_id, FINAL);
    expect(done.escrow_state).toBe("RELEASED_TO_SELLER");

    const s = (await api(`/title-search/${e.search_id}`, { token: buyer })).json;
    expect(s.encumbrance_clearance_score).toBe(100);
    const web = s.agentRuns.filter((r: any) => r.agent_role !== "RECORDS");
    expect(web.every((r: any) => r.status === "SUCCESS" && r.mode === "live" && r.search_log.length > 0)).toBe(true);

    const c = await chainView(e.escrow_id);
    expect(c).toMatchObject({ status: "Released", score: 100 });
    expect(c.wallets.seller.tokens).toBe(1_197_000);
    expect(c.wallets.escrowContract.tokens).toBe(0);
    expect(c.evidenceHash).not.toBe("0x" + "00".repeat(32));
    const methods = c.transactions.map((t: any) => t.method);
    expect(methods).toEqual(expect.arrayContaining(["createEscrow", "faucetTo", "approve", "deposit", "beginVerification", "settle"]));
    expect(methods.indexOf("deposit")).toBeLessThan(methods.indexOf("settle"));
    expect(c.attestations).toEqual([expect.objectContaining({ kind: "VERDICT", outcome: 1, status: "ACCEPTED" })]);
    expect(c.attestations[0].signer.trim()).toBe(c.wallets.oracle.address);
    const v = c.attestations[0].payload;
    expect(v.expiresAt - v.issuedAt).toBe(900);
    expect(v.nonce).toMatch(/^0x[0-9a-f]{64}$/);

    // Scenario E — the same verdict submitted again fails
    const replay = (await api(`/escrow/${e.escrow_id}/chain/security-check`, { token: buyer, body: { kind: "REPLAY" } })).json;
    expect(replay.rejected).toBe(true);
    expect(replay.reason).toMatch(/BadState\(5\)|NonceAlreadyUsed/);

    const ex = (await api("/chain")).json;
    expect(ex.contracts.TitleEscrow.address).toBe(c.contract);
    expect(ex.roles.oracle.address).toBe(c.wallets.oracle.address);
  });

  it("Scenario B — qualifying defect (unreleased mortgage in the EC): signed defect verdict refunds the buyer in full", async () => {
    if (!dbOk) return;
    const { DEMO_EC_DEFECT, DEMO_ROR_DEFECT, textPdf } = await import("../scripts/make-demo-docs.ts");
    const e = await newEscrow(WALK_B, "Kabir Sabnis", 8_000_000);
    await upload(buyer, e.search_id, "EC", "ec.pdf", await textPdf(DEMO_EC_DEFECT, "specimen"));
    await upload(buyer, e.search_id, "ROR", "property-card.pdf", await textPdf(DEMO_ROR_DEFECT, "specimen"));
    await api(`/escrow/${e.escrow_id}/deposit`, { token: buyer, body: { mode: "CHAIN" } });
    const done = await escrowState(buyer, e.escrow_id, FINAL);
    expect(done.escrow_state).toBe("REFUNDED_TO_BUYER");
    const s = (await api(`/title-search/${e.search_id}`, { token: buyer })).json;
    expect(s.assessment.rules.find((r: any) => r.id === "V1").hit).toBe(true);
    const c = await chainView(e.escrow_id);
    expect(c.status).toBe("Refunded");
    expect(c.wallets.buyer.tokens).toBe(800_000);
    expect(c.wallets.seller.tokens).toBe(0);
    expect(c.attestations[0]).toMatchObject({ outcome: 2, status: "ACCEPTED" });
  });

  it("Scenario B (web) — a SARFAESI notice found by TinyFish also refunds the buyer", async () => {
    if (!dbOk) return;
    const e = await newEscrow(PROPS.KONDLI, "Ramesh Kumar Sharma", 4_000_000);
    await api(`/escrow/${e.escrow_id}/deposit`, { token: buyer, body: { mode: "CHAIN" } });
    const done = await escrowState(buyer, e.escrow_id, FINAL);
    expect(done.escrow_state).toBe("REFUNDED_TO_BUYER");
    expect(done.settlement_amount_inr).toBe(400_000);
  });

  it("Scenario C — evidence incomplete: the contract keeps the tokens locked; forged, expired and mismatched verdicts are refused; an advocate resolves it", async () => {
    if (!dbOk) return;
    const e = await newEscrow(PROPS.WHITEFIELD, "Anita Desai", 9_000_000);
    await api(`/escrow/${e.escrow_id}/deposit`, { token: buyer, body: { mode: "CHAIN" } });
    await escrowState(buyer, e.escrow_id, ["DISPUTE_HOLD"]);
    let c = await chainView(e.escrow_id);
    expect(c.status).toBe("Disputed");
    expect(c.wallets.escrowContract.tokens).toBeGreaterThanOrEqual(900_000);
    expect(c.attestations[0]).toMatchObject({ outcome: 3, status: "ACCEPTED" });

    // Scenario D — a forged verdict is rejected by the contract; so are expired and wrong-escrow verdicts
    for (const [kind, err] of [["FORGED_SIGNER", /UnauthorizedSigner/], ["EXPIRED", /AttestationExpired/], ["WRONG_ESCROW", /WrongEscrowOrSearch/]] as const) {
      const r = (await api(`/escrow/${e.escrow_id}/chain/security-check`, { token: buyer, body: { kind } })).json;
      expect(r.rejected, kind).toBe(true);
      expect(r.reason).toMatch(err);
    }
    expect((await chainView(e.escrow_id)).status).toBe("Disputed");

    expect((await api(`/advocate/${e.search_id}/decision`, { token: buyer, body: { decision: "APPROVE", notes: "Checked." } })).status).toBe(403);
    const d = await api(`/advocate/${e.search_id}/decision`, { token: advocate, body: { decision: "APPROVE", notes: "Verified EC and khata at the SRO; the 2021 writ petition concerns a different khata." } });
    expect(d.status).toBe(200);
    const done = await escrowState(buyer, e.escrow_id, ["RELEASED_TO_SELLER", "REFUNDED_TO_BUYER"]);
    expect(done.escrow_state).toBe("RELEASED_TO_SELLER");
    c = await chainView(e.escrow_id);
    expect(c.status).toBe("Released");
    const accepted = c.attestations.filter((a: any) => a.status === "ACCEPTED");
    expect(accepted.at(-1).payload).toMatchObject({ outcome: 1, advocateReviewed: true });
    expect(c.attestations.filter((a: any) => a.kind === "SECURITY_TEST").every((a: any) => a.status === "REJECTED")).toBe(true);
  });

  it("MetaMask path — the buyer's own wallet deposits; the server confirms the deposit on-chain, never from the browser's word", async () => {
    if (!dbOk) return;
    const { DEMO_EC, DEMO_ROR, textPdf } = await import("../scripts/make-demo-docs.ts");
    const { chainCtx, escrowKey } = await import("../src/chain/chain.ts");
    const { ethers } = await import("ethers");
    const e = await newEscrow(WALK_A, "Vihaan Rajadhyaksha", 5_000_000);
    await upload(buyer, e.search_id, "EC", "ec.pdf", await textPdf(DEMO_EC, "specimen"));
    await upload(buyer, e.search_id, "ROR", "property-card.pdf", await textPdf(DEMO_ROR, "specimen"));
    expect((await api(`/escrow/${e.escrow_id}/chain/confirm-deposit`, { token: buyer, body: {} })).status).toBe(409); // nothing deposited yet
    const c = await chainCtx();
    const wallet = ethers.Wallet.createRandom().connect(c.provider);
    const f = await api(`/escrow/${e.escrow_id}/chain/faucet`, { token: buyer, body: { address: wallet.address } });
    expect(f.json.tokens).toBe(500_000);
    await (await (c.token.connect(wallet) as any).approve(await c.escrow.getAddress(), 50_000_000n)).wait();
    await (await (c.escrow.connect(wallet) as any).deposit(escrowKey(e.escrow_id))).wait();
    expect((await api(`/escrow/${e.escrow_id}/chain/confirm-deposit`, { token: buyer, body: {} })).status).toBe(200);
    const done = await escrowState(buyer, e.escrow_id, FINAL);
    expect(done.escrow_state).toBe("RELEASED_TO_SELLER");
    expect((await chainView(e.escrow_id)).wallets.buyer.address).toBe(wallet.address);
  });

  it("a seller-supplied wallet receives the release; monitoring after release catches a new bank notice", async () => {
    if (!dbOk) return;
    const sellerWallet = "0x" + "ab".repeat(20);
    const e = await newEscrow(PROPS.HEBBAL, "Venkatesh Murthy", 12_500_000, { sellerWallet });
    await upload(buyer, e.search_id, "EC", "ec.pdf", await pdf(HEBBAL_EC));
    await upload(buyer, e.search_id, "ROR", "rtc.pdf", await pdf(HEBBAL_ROR));
    await api(`/escrow/${e.escrow_id}/deposit`, { token: buyer, body: { mode: "CHAIN" } });
    expect((await escrowState(buyer, e.escrow_id, FINAL)).escrow_state).toBe("RELEASED_TO_SELLER");
    const c = await chainView(e.escrow_id);
    expect(c.wallets.seller.address.toLowerCase()).toBe(sellerWallet);
    expect(c.wallets.seller.tokens).toBe(1_246_875);
    const s = await waitFor(() => api(`/title-search/${e.search_id}`, { token: buyer }).then((r) => r.json), (x: any) => x.monitor.length > 0);
    mock.hebbalNewLoan = true;
    const run = await api(`/monitor/${s.monitor[0].subscription_id}/run`, { token: buyer, body: {} });
    mock.hebbalNewLoan = false;
    expect(run.json.alerts).toBe(1);
  });

  it("refuses a seller account in someone else's name; the sandbox bank still refuses forged payout signatures", async () => {
    if (!dbOk) return;
    const r = await api("/escrow", { token: buyer, body: {
      property: { addressText: PROPS.HEBBAL.addressText, surveyNumber: "42/2B" }, propertyValueINR: 5_000_000, consentAccepted: true,
      buyer: { name: "Ananya Rao", accountNumber: "50100234567891", ifsc: "HDFC0001234" },
      seller: { name: "Venkatesh Murthy", accountNumber: "123450000", ifsc: "SBIN0004567" }
    } });
    expect(r.status).toBe(422);
    const { executePayout } = await import("../src/escrow/sandboxBank.ts");
    const { one } = await import("../src/db/pool.ts");
    const { canonicalJson } = await import("@titleshield/core");
    const va = await one("SELECT va_number, escrow_reference FROM sandbox_bank_virtual_accounts ORDER BY created_at DESC LIMIT 1");
    const forged = { version: 1, escrowReference: va.escrow_reference, escrowId: crypto.randomUUID(), searchId: crypto.randomUUID(), action: "REFUND_TO_BUYER", beneficiary: "PAYEE_B", amountINR: 1, certificateId: "x", evidenceBundleSha256: "x", verdict: "x", nonce: crypto.randomUUID(), issuedAt: new Date().toISOString() } as const;
    const sig = crypto.sign(null, Buffer.from(canonicalJson(forged)), crypto.generateKeyPairSync("ed25519").privateKey).toString("base64");
    await expect(executePayout({ vaNumber: va.va_number, instruction: forged as any, signature: sig, idempotencyKey: crypto.randomUUID() })).rejects.toThrow(/signature/i);
  });
});

describe("tamper evidence", () => {
  it("verifies certificates and the hash chain, detects altered PDFs, refuses ledger edits", async () => {
    if (!dbOk) return;
    const list = (await api("/title-search", { token: buyer })).json;
    const certId = list.find((s: any) => s.certificate_id?.startsWith("TCC"))!.certificate_id;
    const v = (await api(`/verify/${certId}`)).json;
    expect(v.chainValidUpToThisRow).toBe(true);
    expect((await api("/ledger")).json.integrity.ok).toBe(true);
    const pdfBuf = Buffer.from(await (await fetch(`${BASE}/certificates/${certId}.pdf`)).arrayBuffer());
    const check = async (buf: Buffer) => { const fd = new FormData(); fd.append("file", new Blob([new Uint8Array(buf)], { type: "application/pdf" }), "c.pdf"); return (await fetch(`${BASE}/verify/upload`, { method: "POST", body: fd })).json(); };
    expect((await check(pdfBuf)).match).toBe(true);
    const t = Buffer.from(pdfBuf); t[t.length - 20] ^= 1;
    expect((await check(t)).match).toBe(false);
    const { pool } = await import("../src/db/pool.ts");
    await expect(pool.query("UPDATE immutable_certificate_ledger SET evidence_hash = 'x' WHERE certificate_id = $1", [certId])).rejects.toThrow(/append-only/);
    const anchor = await api("/ledger/anchor", { token: admin, body: {} });
    expect(anchor.json.currentHour.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    expect((await api(`/verify/${certId}`)).json.merkle.verified).toBe(true);
  });
});
