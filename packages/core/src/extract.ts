import { normalizeLender } from "./mortgages.ts";

/**
 * Deterministic extraction from page / document text. No AI: regular patterns for
 * Indian court judgments, SARFAESI bank notices, government notifications and
 * Encumbrance Certificates. When a Gemini key is configured, documents are also
 * read by the vision model (server side); these extractors always run.
 */

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

export function parseIndianDate(s: string | null | undefined): string | null {
  if (!s) return null;
  let m = s.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})\b/);
  if (m) {
    const [_, d, mo, y] = m;
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?([A-Za-z]{3,9}),?\s+(\d{4})\b/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return `${m[3]}-${MONTHS[m[2].slice(0, 3).toLowerCase()]}-${m[1].padStart(2, "0")}`;
  m = s.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${MONTHS[m[1].slice(0, 3).toLowerCase()]}-${m[2].padStart(2, "0")}`;
  m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return m[0];
  return null;
}

export function parseRupees(s: string): number | null {
  const m = s.match(/(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)\s*(lakh|lakhs|crore|crores)?/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (/lakh/i.test(m[2] ?? "")) n *= 1e5;
  if (/crore/i.test(m[2] ?? "")) n *= 1e7;
  return n;
}

const tail = (t: string, n: number) => t.slice(Math.max(0, t.length - n));

// ---------------- court pages ----------------

export interface CaseInfo {
  cnrNumber: string;
  caseType: string;
  court: string;
  petitioner: string;
  respondent: string;
  date: string | null;
  disposed: boolean;
  stay: boolean;
  status: string;
}

const DISPOSAL = /\b(dismissed|is allowed|are allowed|stands allowed|disposed of|stands disposed|decreed|is decreed|withdrawn|compromised|is rejected|stands rejected|accordingly disposed)\b/i;
const STAY = /\b(interim injunction|temporary injunction|ad-?interim injunction|status quo|stay (?:is|was|has been) granted|stay of|restrain(?:ed|ing) from (?:alienating|selling|transferring)|not to alienate|lis pendens)\b/i;
const PENDING = /\b(next (?:date|hearing)|list (?:after|on)|adjourned|pending|stage of|case status\s*:\s*pending)\b/i;

export function extractCase(text: string, title: string, url: string): CaseInfo {
  const t = text.replace(/\s+/g, " ");
  let petitioner = "", respondent = "", date: string | null = null;
  const tm = title.match(/^(.*?)\s+(?:v(?:s)?\.?|versus)\s+(.*?)(?:\s+on\s+(\d{1,2}\s+\w+,?\s+\d{4}))?\s*(?:[-|].*)?$/i);
  if (tm) { petitioner = tm[1].trim(); respondent = tm[2].trim(); date = parseIndianDate(tm[3]); }
  if (!petitioner) {
    const pm = t.match(/([A-Z][A-Za-z.\s]{3,80}?)\s+\.{0,3}\s*(?:Petitioner|Plaintiff|Appellant)s?\b/);
    const rm = t.match(/([A-Z][A-Za-z.\s]{3,80}?)\s+\.{0,3}\s*(?:Respondent|Defendant)s?\b/);
    petitioner = pm?.[1]?.trim() ?? ""; respondent = rm?.[1]?.trim() ?? "";
  }
  const court = (t.match(/\b(?:High Court of [A-Z][A-Za-z ]+|[A-Z][A-Za-z]+ High Court|Supreme Court of India|Court of the [A-Z][A-Za-z ,.()]{3,80}?(?=[.,;]| at\b)|(?:Principal |Additional |Addl\.? )?(?:Senior |Junior )?Civil Judge[A-Za-z ,.()]{0,60}?(?=[.,;])|(?:District|City Civil) Court[A-Za-z ,]{0,40}?(?=[.,;]))/) ?? [""])[0].trim();
  const cnr = (t.match(/\b[A-Z]{4}\d{12}\b/) ?? [""])[0];
  const caseNo = (t.match(/\b(?:O\.?\s?S\.?|W\.?\s?P\.?(?:\(C\))?|R\.?\s?S\.?\s?A\.?|R\.?\s?F\.?\s?A\.?|C\.?\s?R\.?\s?P\.?|M\.?\s?F\.?\s?A\.?|O\.?\s?A\.?|C\.?\s?S\.?|Civil Suit|Original Suit|Writ Petition|Second Appeal|First Appeal|Regular Second Appeal)\s*(?:No\.?|Nos\.?)?\s*\d+\s*(?:\/|of)\s*\d{4}/i) ?? [""])[0];
  if (!date) date = parseIndianDate((t.match(/\b(?:dated?|date of (?:judgment|order|decision)|decided on|pronounced on)\s*[:\-]?\s*([^.;]{6,30})/i) ?? [])[1] ?? "");
  const ending = tail(t, 4000);
  const disposed = DISPOSAL.test(ending) && !/\bcase status\s*:\s*pending\b/i.test(t);
  const stay = !disposed && STAY.test(t);
  const pendingHint = PENDING.test(t);
  const status = disposed
    ? `Disposed — ${(ending.match(DISPOSAL) ?? ["decided"])[0].toLowerCase()}`
    : stay ? "Pending — interim injunction / status quo in force" : pendingHint ? "Pending" : "Status not stated (order or judgment text)";
  return {
    cnrNumber: cnr || caseNo || url.replace(/^https?:\/\//, "").slice(0, 60),
    caseType: caseNo || (title.slice(0, 120) || "Court record"),
    court: court || new URL(url).hostname,
    petitioner: petitioner || "Not stated",
    respondent: respondent || "Not stated",
    date,
    disposed: disposed || (!stay && !pendingHint && /judgment|order/i.test(title + t.slice(0, 500)) && DISPOSAL.test(t)),
    stay,
    status
  };
}

// ---------------- bank / SARFAESI notices ----------------

export interface NoticeInfo { kind: string; lender: string | null; date: string | null; amountINR: number | null; borrower: string | null }

const BANK_NAME = /\b((?:[A-Z][A-Za-z&.]+\s){0,4}(?:Bank|Finance|Financial Services|Housing Finance|Home Finance|Capital|Asset Reconstruction Company|ARC)(?:\s(?:Ltd|Limited|of India))?\.?)/;

export function extractNotice(text: string): NoticeInfo {
  const t = text.replace(/\s+/g, " ");
  const kind = /e-?auction|auction sale|sale notice/i.test(t) ? "Bank auction sale notice"
    : /possession notice|symbolic possession|physical possession/i.test(t) ? "SARFAESI possession notice"
    : /13\s*\(2\)|demand notice/i.test(t) ? "SARFAESI demand notice (s.13(2))" : "Bank notice";
  const lenderRaw = (t.match(BANK_NAME) ?? [null])[0];
  const lender = lenderRaw ? normalizeLender(lenderRaw) : null;
  const date = parseIndianDate((t.match(/\b(?:date|dated|on)\s*[:\-]?\s*(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})/i) ?? [])[1] ?? "") ?? parseIndianDate(t);
  const amountINR = parseRupees((t.match(/(?:outstanding|dues|amount|reserve price)[^.]{0,80}?(?:Rs\.?|INR|₹)\s*[\d,]+(?:\.\d{1,2})?\s*(?:lakhs?|crores?)?/i) ?? [""])[0]) ?? parseRupees(t);
  const borrower = ((t.match(/\b(?:borrower|mortgagor|guarantor)s?\s*[:\-]?\s*(?:Mr\.?|Mrs\.?|Smt\.?|Shri\.?|Sri\.?)?\s*([A-Z][A-Za-z.]+(?:\s[A-Z][A-Za-z.]+){1,3})/) ?? [])[1]) ?? null;
  return { kind, lender, date, amountINR, borrower };
}

// ---------------- government restrictions ----------------

const RESTRICTION = /(land acquisition|acquisition of land|notification under section (?:4|6|11|19)|section 11\(1\)|rfctlarr|preliminary notification|final notification|prohibited (?:property|land)|22-?a\b|section 22-?a|assigned land|ptcl|granted land|forest land|reserved forest|wakf|waqf|government land|poramboke|evacuee property|ceiling surplus|lake bed|buffer zone|crz|coastal regulation zone|green belt)/i;

export function extractRestriction(text: string): { kind: string; sentence: string } | null {
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.;])\s+/);
  for (const s of sentences) {
    const m = s.match(RESTRICTION);
    if (m) return { kind: m[1].toLowerCase(), sentence: s.slice(0, 400) };
  }
  return null;
}

// ---------------- Encumbrance Certificate text ----------------

export interface EcEntry {
  documentNumber: string; registrationDate: string; transactionNature: string;
  executant: string | null; claimant: string | null; lenderOrClaimantName: string | null; loanReference: string | null;
  isActiveLien: boolean; loanAmountINR: number | null;
}

const NATURE = /(sale deed|conveyance|mortgage(?: deed)?|deposit of title deeds|modt|equitable mortgage|simple mortgage|release(?: deed)?|reconveyance|discharge|receipt|gift(?: deed)?|settlement(?: deed)?|partition(?: deed)?|agreement(?: of sale| to sell)?|power of attorney|lease(?: deed)?|will|exchange|rectification|cancellation|court (?:decree|attachment)|attachment)/i;
const DOCNO = /\b(\d{1,6}\s*\/\s*\d{4}(?:\s*-\s*\d{2,4})?)\b/g;

export function parseEcText(text: string): { entries: EcEntry[]; coverageFromYear: number | null } {
  const t = text.replace(/\r/g, "").replace(/[ \t]+/g, " ");
  const cov = t.match(/(?:period|from)\s*[:\-]?\s*(\d{1,2}[-\/.]\d{1,2}[-\/.](\d{4}))\s*(?:to|-)\s*(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4})/i);
  const coverageFromYear = cov ? Number(cov[2]) : null;
  const entries: EcEntry[] = [];
  const seen = new Set<string>();
  const hits = [...t.matchAll(DOCNO)];
  for (let i = 0; i < hits.length; i++) {
    const m = hits[i];
    const docNo = m[1].replace(/\s+/g, "");
    if (seen.has(docNo)) continue;
    const end = hits[i + 1]?.index ?? Math.min(t.length, m.index! + 700);
    const block = t.slice(m.index!, Math.min(end, m.index! + 700));
    const nature = block.match(NATURE);
    const date = parseIndianDate(block);
    if (!nature || !date) continue;
    seen.add(docNo);
    const executant = (block.match(/\b(?:executant|executants|vendor|mortgagor|transferor|first party)s?\s*(?:\(s\))?\s*[:\-]\s*([^\n:]{3,80}?)(?=\s+(?:claimant|vendee|mortgagee|transferee|second party|consideration|market|$)|\n)/i) ?? [])[1]?.trim() ?? null;
    const claimant = (block.match(/\b(?:claimant|claimants|vendee|purchaser|mortgagee|transferee|second party)s?\s*(?:\(s\))?\s*[:\-]\s*([^\n:]{3,80}?)(?=\s+(?:consideration|market|executant|$)|\n)/i) ?? [])[1]?.trim() ?? null;
    const lenderRaw = (block.match(BANK_NAME) ?? [null])[0];
    const nat = nature[1];
    const isMortgageish = /mortgage|deposit of title|modt|release|reconveyance|discharge/i.test(nat);
    entries.push({
      documentNumber: docNo, registrationDate: date, transactionNature: nat.replace(/\b\w/g, (c) => c.toUpperCase()),
      executant, claimant,
      lenderOrClaimantName: isMortgageish ? (lenderRaw ? normalizeLender(lenderRaw) : claimant) : null,
      loanReference: (block.match(/\b(?:loan|a\/c|account)\s*(?:no\.?|number|ref\.?)?\s*[:\-]?\s*([A-Z0-9\-\/]{5,20})/i) ?? [])[1] ?? null,
      isActiveLien: false,
      loanAmountINR: parseRupees(block)
    });
  }
  return { entries, coverageFromYear };
}

/** Record of Rights text: owners and remarks/liabilities. */
export function parseRorText(text: string): { owners: string[]; liabilities: string[]; extent: string | null } {
  const t = text.replace(/\r/g, "");
  const owners = new Set<string>();
  for (const m of t.matchAll(/\b(?:owner|owners|khatedar|khatadar|pattadar|occupant|bhumiswami|name of (?:the )?(?:owner|holder|khatedar|pattadar))s?\s*(?:name)?\s*[:\-]\s*([A-Z][A-Za-z.\s\/]{3,80})/gi)) {
    const n = m[1].split(/\n|\s{2,}/)[0].trim();
    if (n.split(/\s+/).length >= 2) owners.add(n);
  }
  const liabilities = t.split(/\n/).map((l) => l.trim()).filter((l) => /loan|bank|mortgage|charge|society|acquisition|prohibited|assigned|ptcl|government|forest|wakf|inam|sarkari|22-?a/i.test(l)).slice(0, 10);
  const extent = (t.match(/\b(?:extent|area)\s*[:\-]?\s*([\d.]+\s*(?:acres?|guntas?|hectares?|ha|sq\.?\s?(?:m|ft|yds?)|cents?)[^\n]{0,30})/i) ?? [])[1] ?? null;
  return { owners: [...owners], liabilities, extent };
}
