import type { PortalExtraction } from "./schemas.ts";
import { matchMortgages, type LienFinding } from "./mortgages.ts";
import { buildChain, ownerMatchesClaim, type ChainResult } from "./chain.ts";
import { compareNames, sameParty, type NameMatch } from "./names/resolver.ts";

/**
 * Deterministic Title Rule & Scoring Engine (PDF §5). An LLM never decides:
 * these rules turn structured facts into the encumbranceClearanceScore.
 *
 *   S = max(0, 100 − Σ wᵢ·Iᵢ) × Π (1 − Vₖ)
 */

export const WEIGHTS = { mutationLag: 15, patronymicVariance: 5, oldDischargedLitigation: 10, ecDigitizationGap: 20 } as const;
export const THRESHOLDS = { clean: 90, review: 50 } as const;
export const RULESET_VERSION = "TS-RULES-1.0.0";

export type Verdict = "CLEAN_TITLE" | "CONDITIONAL_REVIEW" | "REJECTED";
export type EscrowAction = "RELEASE_TO_SELLER" | "DISPUTE_HOLD" | "REFUND_TO_BUYER";

export interface LitigationFinding {
  cnrNumber: string; caseType: string; courtName: string; petitioner: string; respondent: string;
  currentStatus: string; filingDate: string; disposalDate: string | null;
  pending: boolean; stay: boolean; onProperty: boolean; ageYears: number | null; relevance: string;
}

export interface RuleResult { id: string; label: string; hit: boolean; weight?: number; detail: string; kind: "VETO" | "DEDUCTION" | "GUARDRAIL" }

export interface TitleAssessment {
  score: number;
  rawScore: number;
  verdict: Verdict;
  escrowAction: EscrowAction;
  hasActiveMortgage: boolean;
  pendingLitigationCount: number;
  lastOwnerName: string;
  rules: RuleResult[];
  liens: LienFinding[];
  litigation: LitigationFinding[];
  chain: ChainResult;
  ownerMatch: NameMatch | null;
  prohibitedCategory: string | null;
  riskBreakdown: {
    activeBankLienDetected: boolean;
    activeCivilLitigationDetected: boolean;
    chainOfTitleContinuous30Yrs: boolean;
    mutationSyncedWithSubRegistrar: boolean;
    prohibitedLandCategory: boolean;
  };
  incompletePortals: string[];
  rulesetVersion: string;
}

const DISPOSED = /dispos|dismiss|decided|closed|withdrawn|compromis|decreed|settled|abated|rejected|disposed/i;
const STAY = /stay|injunction|status quo|attach|restrain|lis pendens/i;
const PROHIBITED = /wakf|waqf|forest|assigned|ptcl|granted land|poramboke|porambok|sarkari|government land|govt\.? land|inam|ceiling surplus|prohibited|22-?a|evacuee|endowment|temple land|devasthan|land acquisition|acquisition of land|section 11\(1\)|rfctlarr|preliminary notification/i;
const EC_SOURCES = new Set(["UPLOADED_EC", "IGR_EC", "KAVERI_KA", "IGR_TELANGANA_EC", "IGRS_AP", "IGRS_UP", "IGR_MAHARASHTRA", "GARVI_GJ", "TNREGINET"]);
const ROR_SOURCES = new Set(["UPLOADED_ROR", "BHOOMI_KA", "DHARANI_TS", "MEEBHOOMI_AP", "BHULEKH_UP", "MAHABHULEKH_MH", "ANYROR_GJ", "TNESERVICES_TN"]);

function yearsBetween(a: string, b: Date) {
  const t = Date.parse(a);
  return Number.isFinite(t) ? (b.getTime() - t) / (365.25 * 86400 * 1000) : null;
}

export interface AssessInput {
  extractions: PortalExtraction[];
  surveyNumber: string;
  claimedOwnerName?: string | null;
  failedPortals?: string[];
  asOf?: Date;
}

export function assessTitle(input: AssessInput): TitleAssessment {
  const asOf = input.asOf ?? new Date();
  const ok = input.extractions.filter((x) => (x.portalStatus ?? "OK") === "OK");
  const incompletePortals = [
    ...(input.failedPortals ?? []),
    ...input.extractions.filter((x) => (x.portalStatus ?? "OK") !== "OK").map((x) => `${x.portalName}:${x.portalStatus}`)
  ];

  // ---- facts ----
  const hasEc = ok.some((x) => EC_SOURCES.has(x.portalName));
  const hasRor = ok.some((x) => ROR_SOURCES.has(x.portalName) && x.currentOwnerNames.length > 0);
  const mediumFindings = ok.flatMap((x) => x.findings ?? []).filter((f) => f.strength === "MEDIUM" && f.kind !== "RERA_PROJECT" && f.kind !== "OTHER");
  const liens = matchMortgages(ok);
  const activeLiens = liens.filter((l) => !l.released);
  const hasActiveMortgage = activeLiens.length > 0;

  const chain = buildChain(ok, asOf);
  const partyNames = new Set<string>(chain.links.flatMap((l) => [l.from, l.to]));
  if (chain.currentOwner) partyNames.add(chain.currentOwner);

  const litigation: LitigationFinding[] = ok.flatMap((x) => x.litigationCases).map((c) => {
    const pending = !DISPOSED.test(c.currentStatus);
    const stay = pending && (c.hasStayOrInjunction === true || STAY.test(c.currentStatus));
    const onProperty = c.matchedBy === "SURVEY_NUMBER" || (input.surveyNumber ? `${c.caseType} ${c.currentStatus}`.includes(input.surveyNumber) : false);
    const partyHit = [...partyNames].some((p) => sameParty(p, c.petitioner) || sameParty(p, c.respondent));
    const ref = c.disposalDate || c.filingDate;
    return {
      cnrNumber: c.cnrNumber, caseType: c.caseType, courtName: c.courtName, petitioner: c.petitioner, respondent: c.respondent,
      currentStatus: c.currentStatus, filingDate: c.filingDate, disposalDate: c.disposalDate ?? null,
      pending, stay, onProperty, ageYears: ref ? yearsBetween(ref, asOf) : null,
      relevance: onProperty ? "Survey/plot number match" : partyHit ? "Owner-name match" : "Weak match"
    };
  }).filter((c, i, arr) => arr.findIndex((d) => d.cnrNumber === c.cnrNumber) === i);
  const pendingCases = litigation.filter((c) => c.pending && c.relevance !== "Weak match");
  const vetoCases = pendingCases.filter((c) => c.stay && c.onProperty);
  const oldDischarged = litigation.filter((c) => !c.pending && (c.ageYears ?? 0) > 10);

  const liabilityText = ok.flatMap((x) => x.otherRightsAndLiabilities ?? []);
  const prohibitedHit = liabilityText.find((t) => PROHIBITED.test(t)) ?? null;

  const windowStartYear = asOf.getFullYear() - 30;
  const ecYears = ok.map((x) => x.ecCoverageFromYear).filter((y): y is number => typeof y === "number");
  const ecFrom = ecYears.length ? Math.min(...ecYears) : null;
  const ecGap = ecFrom !== null && ecFrom > windowStartYear;

  // Owner identity: record owner across portals + claimed seller.
  const recordOwner = chain.currentOwner ?? ok.flatMap((x) => x.currentOwnerNames)[0] ?? "";
  const ownerMatch = ownerMatchesClaim(input.claimedOwnerName, recordOwner);
  const crossPortal = ok.flatMap((x) => x.currentOwnerNames).filter(Boolean).map((n) => compareNames(n, recordOwner));
  const patronymicVariance = (ownerMatch?.kind === "variance") || crossPortal.some((m) => m.kind === "variance");

  // ---- rules ----
  const rules: RuleResult[] = [
    { id: "V1", kind: "VETO", label: "Active bank mortgage / charge", hit: hasActiveMortgage,
      detail: hasActiveMortgage ? activeLiens.map((l) => `${l.lender} · doc ${l.documentNumber} (${l.registrationDate}) · ${l.reason}`).join("; ") : `${liens.length} mortgage(s) found, all discharged` },
    { id: "V2", kind: "VETO", label: "Pending suit with stay/injunction on this survey number", hit: vetoCases.length > 0,
      detail: vetoCases.length ? vetoCases.map((c) => `${c.cnrNumber} · ${c.caseType} · ${c.currentStatus}`).join("; ") : "No live stay or injunction on the property" },
    { id: "V3", kind: "VETO", label: "Prohibited / restricted land category", hit: !!prohibitedHit,
      detail: prohibitedHit ?? "Not Wakf, forest, assigned/PTCL or government poramboke land" },
    { id: "D1", kind: "DEDUCTION", weight: WEIGHTS.mutationLag, label: "Mutation lags the latest registered sale deed", hit: chain.mutationLagging,
      detail: chain.lagDetail ?? "Revenue record matches the latest registered transfer" },
    { id: "D2", kind: "DEDUCTION", weight: WEIGHTS.patronymicVariance, label: "Spelling/transliteration variance in owner's name or patronymic", hit: patronymicVariance,
      detail: patronymicVariance ? [...(ownerMatch?.notes ?? []), ...crossPortal.flatMap((m) => m.notes)].filter((v, i, a) => v && a.indexOf(v) === i).join("; ") || "Minor variance" : "Names consistent across records" },
    { id: "D3", kind: "DEDUCTION", weight: WEIGHTS.oldDischargedLitigation, label: "Discharged litigation older than 10 years", hit: oldDischarged.length > 0,
      detail: oldDischarged.length ? oldDischarged.map((c) => `${c.cnrNumber} · ${c.currentStatus}`).join("; ") : "None" },
    { id: "D4", kind: "DEDUCTION", weight: WEIGHTS.ecDigitizationGap, label: `EC not digitised back to ${windowStartYear} (manual Index-II check needed)`, hit: ecGap,
      detail: ecFrom === null ? "EC coverage not reported" : `Online EC available from ${ecFrom}` }
  ];

  const deduction = rules.filter((r) => r.kind === "DEDUCTION" && r.hit).reduce((s, r) => s + (r.weight ?? 0), 0);
  const vetoProduct = rules.filter((r) => r.kind === "VETO").reduce((p, r) => p * (1 - (r.hit ? 1 : 0)), 1);
  const rawScore = Math.max(0, 100 - deduction) * vetoProduct;

  // Guardrails (prototype additions, documented in docs/ARCHITECTURE.md): conditions the PDF flags
  // but does not weight. They can never auto-clear, so the score is capped inside the review band.
  const guardrails: RuleResult[] = [
    { id: "G1", kind: "GUARDRAIL", label: "Chain of title break", hit: !chain.continuous, detail: chain.breaks.map((b) => b.problem).join("; ") || "Continuous" },
    { id: "G2", kind: "GUARDRAIL", label: "Seller is not the owner on record", hit: ownerMatch?.kind === "mismatch", detail: ownerMatch ? `Claimed "${input.claimedOwnerName}" vs record "${recordOwner}" (${Math.round(ownerMatch.score * 100)}%)` : !input.claimedOwnerName ? "No seller name supplied" : "Owner on record not known yet (no Record of Rights)" },
    { id: "G3", kind: "GUARDRAIL", label: "Official records or checks incomplete", hit: incompletePortals.length > 0 || !hasEc || !hasRor,
      detail: [!hasEc ? "Encumbrance Certificate not provided" : "", !hasRor ? "Record of Rights not provided (or owner not readable)" : "", ...incompletePortals].filter(Boolean).join("; ") || "EC, RoR and all web checks complete" },
    { id: "G4", kind: "GUARDRAIL", label: "Pending case without stay (owner/property)", hit: pendingCases.length > vetoCases.length, detail: pendingCases.filter((c) => !vetoCases.includes(c)).map((c) => `${c.cnrNumber} · ${c.currentStatus}`).join("; ") || "None" },
    { id: "G5", kind: "GUARDRAIL", label: "Possible match in court, bank or government records needs checking", hit: mediumFindings.length > 0,
      detail: mediumFindings.map((f) => `${f.kind.replace(/_/g, " ").toLowerCase()}: ${f.title}`).join("; ") || "No unconfirmed matches" }
  ];
  rules.push(...guardrails);
  let score = rawScore;
  if (guardrails.some((g) => g.hit) && score >= THRESHOLDS.clean) score = THRESHOLDS.clean - 1;

  const vetoed = vetoProduct === 0;
  let verdict: Verdict;
  if (vetoed || score < THRESHOLDS.review) verdict = "REJECTED";
  else if (score >= THRESHOLDS.clean && !hasActiveMortgage && pendingCases.length === 0) verdict = "CLEAN_TITLE";
  else verdict = "CONDITIONAL_REVIEW";

  const escrowAction: EscrowAction = verdict === "CLEAN_TITLE" ? "RELEASE_TO_SELLER" : verdict === "REJECTED" ? "REFUND_TO_BUYER" : "DISPUTE_HOLD";

  return {
    score: Math.round(score),
    rawScore: Math.round(rawScore),
    verdict,
    escrowAction,
    hasActiveMortgage,
    pendingLitigationCount: pendingCases.length,
    lastOwnerName: recordOwner,
    rules,
    liens,
    litigation,
    chain,
    ownerMatch,
    prohibitedCategory: prohibitedHit,
    riskBreakdown: {
      activeBankLienDetected: hasActiveMortgage,
      activeCivilLitigationDetected: pendingCases.length > 0,
      chainOfTitleContinuous30Yrs: chain.continuous && !ecGap,
      mutationSyncedWithSubRegistrar: !chain.mutationLagging,
      prohibitedLandCategory: !!prohibitedHit
    },
    incompletePortals,
    rulesetVersion: RULESET_VERSION
  };
}

/** Re-apply an advocate's decision on a CONDITIONAL_REVIEW case. */
export function applyAdvocateDecision(a: TitleAssessment, decision: "APPROVE" | "REJECT"): Pick<TitleAssessment, "verdict" | "escrowAction"> {
  if (a.verdict !== "CONDITIONAL_REVIEW") return { verdict: a.verdict, escrowAction: a.escrowAction };
  return decision === "APPROVE"
    ? { verdict: "CLEAN_TITLE", escrowAction: "RELEASE_TO_SELLER" }
    : { verdict: "REJECTED", escrowAction: "REFUND_TO_BUYER" };
}
