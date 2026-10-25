import type { PortalExtraction } from "./schemas.ts";

/**
 * Mortgage-release matching (PDF §4.1 stage 3): every MORTGAGE_DEED / MODT in the
 * Encumbrance Certificate needs a later RECONVEYANCE_DEED / DISCHARGE_RECEIPT from
 * the same lender for the same loan or document. Anything unmatched is an active lien.
 */

export type EncumbranceKind =
  | "SALE" | "MORTGAGE" | "RELEASE" | "GIFT" | "PARTITION" | "SETTLEMENT" | "LEASE"
  | "AGREEMENT" | "COURT_ATTACHMENT" | "OTHER";

export function classifyTransaction(nature: string): EncumbranceKind {
  const s = nature.toLowerCase();
  if (/re-?conveyance|discharge|release|redemption|satisfaction|cancellation of mortgage|no due|closure/.test(s)) return "RELEASE";
  if (/mortgage|modt|deposit of title|equitable|hypothecat|charge|simple mortgage|bandhak|rehan|sarfaesi|security interest|possession notice|demand notice|auction/.test(s)) return "MORTGAGE";
  if (/attach|decree|court|injunction|lis pendens/.test(s)) return "COURT_ATTACHMENT";
  if (/agreement to sell|sale agreement|agreement/.test(s)) return "AGREEMENT";
  if (/sale|conveyance|bainama|kraya/.test(s)) return "SALE";
  if (/gift|dan patra|daanpatra/.test(s)) return "GIFT";
  if (/partition|batwara/.test(s)) return "PARTITION";
  if (/settlement/.test(s)) return "SETTLEMENT";
  if (/lease|rent/.test(s)) return "LEASE";
  return "OTHER";
}

const LENDER_ALIASES: Array<[RegExp, string]> = [
  [/\bsbi\b|state bank of india/, "STATE BANK OF INDIA"],
  [/hdfc/, "HDFC BANK"],
  [/icici/, "ICICI BANK"],
  [/axis/, "AXIS BANK"],
  [/kotak/, "KOTAK MAHINDRA BANK"],
  [/\bpnb\b|punjab national/, "PUNJAB NATIONAL BANK"],
  [/\bbob\b|bank of baroda/, "BANK OF BARODA"],
  [/canara/, "CANARA BANK"],
  [/union bank|andhra bank|corporation bank/, "UNION BANK OF INDIA"],
  [/bajaj/, "BAJAJ FINANCE"],
  [/\blic\b|lic housing/, "LIC HOUSING FINANCE"],
  [/yes bank/, "YES BANK"],
  [/indian bank|allahabad bank/, "INDIAN BANK"],
  [/co-?op|cooperative|pacs|society/, "CO-OPERATIVE SOCIETY"]
];

export function normalizeLender(name: string | null | undefined): string {
  const s = (name ?? "").toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, canon] of LENDER_ALIASES) if (re.test(s)) return canon;
  return s.toUpperCase().replace(/\b(LTD|LIMITED|BRANCH.*)$/g, "").trim();
}

export interface LienFinding {
  documentNumber: string;
  registrationDate: string;
  lender: string;
  loanReference: string | null;
  amountINR: number | null;
  source: string;
  released: boolean;
  releasedBy: string | null;
  reason: string;
}

type Enc = PortalExtraction["encumbrances"][number] & { _portal: string };

function refsOverlap(a: Enc, b: Enc): boolean {
  const ra = [a.loanReference, a.documentNumber].filter(Boolean).map((x) => String(x).toUpperCase());
  const hay = [b.loanReference, b.transactionNature, b.documentNumber].filter(Boolean).join(" ").toUpperCase();
  return ra.some((r) => r.length >= 3 && hay.includes(r));
}

export function matchMortgages(extractions: PortalExtraction[]): LienFinding[] {
  const all: Enc[] = extractions.flatMap((x) => x.encumbrances.map((e) => ({ ...e, _portal: x.portalName })));
  const mortgages = all.filter((e) => classifyTransaction(e.transactionNature) === "MORTGAGE");
  const releases = all.filter((e) => classifyTransaction(e.transactionNature) === "RELEASE");
  const usedReleases = new Set<Enc>();
  const seen = new Set<string>();
  const findings: LienFinding[] = [];

  for (const m of mortgages.sort((a, b) => a.registrationDate.localeCompare(b.registrationDate))) {
    const lender = normalizeLender(m.lenderOrClaimantName ?? m.claimant);
    const key = `${lender}|${m.loanReference ?? m.documentNumber}`;
    if (seen.has(key)) continue; // same charge reported by two portals (EC + CERSAI)
    seen.add(key);

    const candidates = releases.filter((r) => !usedReleases.has(r)
      && normalizeLender(r.lenderOrClaimantName ?? r.executant) === lender
      && r.registrationDate >= m.registrationDate);
    const exact = candidates.find((r) => refsOverlap(m, r));
    // Fall back to same-lender release only when neither side carries a reference.
    const loose = !exact && !m.loanReference ? candidates.find((r) => !r.loanReference) : undefined;
    const rel = exact ?? loose;
    if (rel) usedReleases.add(rel);

    const agentSaysActive = m.isActiveLien && !rel;
    findings.push({
      documentNumber: m.documentNumber,
      registrationDate: m.registrationDate,
      lender,
      loanReference: m.loanReference ?? null,
      amountINR: m.loanAmountINR,
      source: m._portal,
      released: !!rel,
      releasedBy: rel ? `${rel.documentNumber} (${rel.registrationDate})` : null,
      reason: rel
        ? (exact ? "Matching discharge for the same lender and loan reference" : "Later discharge by the same lender")
        : agentSaysActive ? "No registered discharge; registry marks the charge as subsisting" : "No registered discharge or reconveyance found"
    });
  }
  return findings;
}
