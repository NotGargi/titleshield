import { z } from "zod";

/**
 * Portal codes. The PDF lists BHULEKH_UP, MEEBHOOMI_AP, BHOOMI_KA, DHARANI_TS,
 * ECOURTS_NJDG and IGR_EC; the remaining codes cover the other portals the PDF
 * names (state IGR portals, CERSAI, AnyROR, MahaBhulekh, TNREGINET).
 */
export const PORTAL_CODES = [
  "BHULEKH_UP", "IGRS_UP",
  "MEEBHOOMI_AP", "IGRS_AP",
  "BHOOMI_KA", "KAVERI_KA",
  "DHARANI_TS", "IGR_TELANGANA_EC",
  "MAHABHULEKH_MH", "IGR_MAHARASHTRA",
  "ANYROR_GJ", "GARVI_GJ",
  "TNESERVICES_TN", "TNREGINET",
  "ECOURTS_NJDG", "CERSAI", "IGR_EC",
  // Free-tier sources: TinyFish Search + Fetch agents, and records uploaded by the user
  "WEB_COURT_RECORDS", "WEB_BANK_NOTICES", "WEB_GOVT_NOTICES",
  "UPLOADED_EC", "UPLOADED_ROR", "UPLOADED_DEED", "UPLOADED_COURT"
] as const;
export type PortalCode = (typeof PORTAL_CODES)[number];

export const TRANSFER_TYPES = ["SALE", "INHERITANCE", "GIFT", "MORTGAGE", "PARTITION", "COURT_DECREE"] as const;
export type TransferType = (typeof TRANSFER_TYPES)[number];

const normalizeTransferType = (v: unknown) => {
  const s = String(v ?? "").toUpperCase();
  if (/SALE|CONVEY/.test(s)) return "SALE";
  if (/INHERIT|SUCCESS|WILL|VARASAT|VIRASAT|LEGAL HEIR/.test(s)) return "INHERITANCE";
  if (/GIFT|DAN|SETTLEMENT/.test(s)) return "GIFT";
  if (/MORTGAGE|MODT|HYPOTH|CHARGE/.test(s)) return "MORTGAGE";
  if (/PARTITION|BATWARA|DIVISION/.test(s)) return "PARTITION";
  if (/COURT|DECREE|ORDER/.test(s)) return "COURT_DECREE";
  return s;
};

export const FindingSchema = z.object({
  kind: z.enum(["COURT_CASE", "BANK_NOTICE", "GOVT_RESTRICTION", "RERA_PROJECT", "OTHER"]),
  strength: z.enum(["STRONG", "MEDIUM", "WEAK"]),
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  reasons: z.array(z.string()),
  detail: z.record(z.string(), z.any()).optional()
});
export type Finding = z.infer<typeof FindingSchema>;

export const SourceLogSchema = z.object({
  query: z.string(),
  domains: z.array(z.string()),
  results: z.number(),
  cached: z.boolean(),
  urls: z.array(z.object({ url: z.string(), title: z.string() }))
});

/** Strict output schema every agent and document reader must produce (PDF §3.2). */
export const PortalExtractionSchema = z.object({
  portalName: z.enum(PORTAL_CODES),
  extractionTimestamp: z.string().datetime({ offset: true }),
  surveyNumberMatched: z.string(),
  currentOwnerNames: z.array(z.string()),
  mutationHistory: z.array(z.object({
    mutationNumber: z.string(),
    mutationDate: z.string(),
    transferType: z.preprocess(normalizeTransferType, z.enum(TRANSFER_TYPES)),
    transferor: z.string(),
    transferee: z.string(),
    isVerified: z.boolean()
  })),
  encumbrances: z.array(z.object({
    documentNumber: z.string(),
    registrationDate: z.string(),
    transactionNature: z.string(),
    executant: z.string().nullable().optional(),
    claimant: z.string().nullable().optional(),
    lenderOrClaimantName: z.string().nullable(),
    loanReference: z.string().nullable().optional(),
    isActiveLien: z.boolean(),
    loanAmountINR: z.number().nullable()
  })),
  litigationCases: z.array(z.object({
    cnrNumber: z.string(),
    caseType: z.string(),
    filingDate: z.string(),
    courtName: z.string(),
    petitioner: z.string(),
    respondent: z.string(),
    currentStatus: z.string(),
    hasStayOrInjunction: z.boolean().optional(),
    disposalDate: z.string().nullable().optional(),
    matchedBy: z.enum(["PARTY_NAME", "SURVEY_NUMBER"]).optional()
  })),
  rawArtifactUrls: z.array(z.string()),
  // Extensions the PDF's goal prompts ask for (RTC column 11, EC coverage) but its schema omits.
  otherRightsAndLiabilities: z.array(z.string()).optional(),
  landExtent: z.string().nullable().optional(),
  ecCoverageFromYear: z.number().int().nullable().optional(),
  recordLanguage: z.string().nullable().optional(),
  portalStatus: z.enum(["OK", "NO_RECORD_FOUND", "PORTAL_DOWN", "SITE_BLOCKED"]).optional(),
  findings: z.array(FindingSchema).optional(),
  sourceLog: z.array(SourceLogSchema).optional()
});
export type PortalExtraction = z.infer<typeof PortalExtractionSchema>;

/**
 * The same contract as a JSON schema (OpenAPI dialect: type, properties, required,
 * items, enum, nullable) — the response schema given to the document reader.
 */
export const extractionJsonSchema = {
  type: "object",
  properties: {
    surveyNumberMatched: { type: "string" },
    currentOwnerNames: { type: "array", items: { type: "string" } },
    landExtent: { type: "string", nullable: true },
    recordLanguage: { type: "string", nullable: true },
    ecCoverageFromYear: { type: "integer", nullable: true },
    portalStatus: { type: "string", enum: ["OK", "NO_RECORD_FOUND", "PORTAL_DOWN", "SITE_BLOCKED"] },
    otherRightsAndLiabilities: { type: "array", items: { type: "string" } },
    mutationHistory: {
      type: "array",
      items: {
        type: "object",
        properties: {
          mutationNumber: { type: "string" },
          mutationDate: { type: "string" },
          transferType: { type: "string", enum: [...TRANSFER_TYPES] },
          transferor: { type: "string" },
          transferee: { type: "string" },
          isVerified: { type: "boolean" }
        },
        required: ["mutationNumber", "mutationDate", "transferType", "transferor", "transferee", "isVerified"]
      }
    },
    encumbrances: {
      type: "array",
      items: {
        type: "object",
        properties: {
          documentNumber: { type: "string" },
          registrationDate: { type: "string" },
          transactionNature: { type: "string" },
          executant: { type: "string", nullable: true },
          claimant: { type: "string", nullable: true },
          lenderOrClaimantName: { type: "string", nullable: true },
          loanReference: { type: "string", nullable: true },
          isActiveLien: { type: "boolean" },
          loanAmountINR: { type: "number", nullable: true }
        },
        required: ["documentNumber", "registrationDate", "transactionNature", "isActiveLien"]
      }
    },
    litigationCases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cnrNumber: { type: "string" },
          caseType: { type: "string" },
          filingDate: { type: "string" },
          courtName: { type: "string" },
          petitioner: { type: "string" },
          respondent: { type: "string" },
          currentStatus: { type: "string" },
          hasStayOrInjunction: { type: "boolean" },
          disposalDate: { type: "string", nullable: true },
          matchedBy: { type: "string", enum: ["PARTY_NAME", "SURVEY_NUMBER"] }
        },
        required: ["cnrNumber", "caseType", "courtName", "petitioner", "respondent", "currentStatus"]
      }
    },
    rawArtifactUrls: { type: "array", items: { type: "string" } }
  },
  required: ["portalStatus", "currentOwnerNames", "mutationHistory", "encumbrances", "litigationCases"]
} as const;

/** Fill defaults so a partial (but valid-looking) agent result can be validated strictly. */
export function normalizeAgentResult(portalName: PortalCode, raw: any, surveyNumber: string): PortalExtraction {
  const r = raw && typeof raw === "object" && raw.result && typeof raw.result === "object" && !Array.isArray(raw.result) ? raw.result : raw ?? {};
  return PortalExtractionSchema.parse({
    portalName,
    extractionTimestamp: r.extractionTimestamp ?? new Date().toISOString(),
    surveyNumberMatched: String(r.surveyNumberMatched ?? surveyNumber),
    currentOwnerNames: r.currentOwnerNames ?? [],
    mutationHistory: (r.mutationHistory ?? []).map((m: any) => ({ isVerified: false, ...m })),
    encumbrances: (r.encumbrances ?? []).map((e: any) => ({ lenderOrClaimantName: null, loanAmountINR: null, isActiveLien: false, ...e })),
    litigationCases: (r.litigationCases ?? []).map((c: any) => ({ filingDate: "", ...c })),
    rawArtifactUrls: r.rawArtifactUrls ?? [],
    findings: r.findings ?? [],
    sourceLog: r.sourceLog ?? [],
    otherRightsAndLiabilities: r.otherRightsAndLiabilities ?? [],
    landExtent: r.landExtent ?? null,
    ecCoverageFromYear: r.ecCoverageFromYear ?? null,
    recordLanguage: r.recordLanguage ?? null,
    portalStatus: r.portalStatus ?? "OK"
  });
}

/** Canonical output contract (PDF §5.1). */
export interface TitleClearanceOutput {
  searchId: string;
  propertyIdentifier: { state: string; district: string; taluk: string; village: string; surveyNumber: string };
  hasActiveMortgage: boolean;
  pendingLitigationCount: number;
  lastOwnerName: string;
  encumbranceClearanceScore: number;
  riskBreakdown: {
    activeBankLienDetected: boolean;
    activeCivilLitigationDetected: boolean;
    chainOfTitleContinuous30Yrs: boolean;
    mutationSyncedWithSubRegistrar: boolean;
    prohibitedLandCategory: boolean;
  };
  certificateMetadata: {
    certificateId: string;
    sha256DocumentHash: string;
    dscSignatureSerial: string;
    verificationUrl: string;
  };
}
