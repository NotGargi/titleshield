import { describe, expect, it } from "vitest";
import {
  krutiDevToUnicode, transliterate, compareNames, phoneticKey, matchMortgages, buildChain, assessTitle,
  ledgerRowHash, verifyLedger, GENESIS_HASH, merkleRoot, merkleProof, verifyMerkleProof, resolveAddress,
  normalizeAgentResult, type PortalExtraction
} from "../src/index.ts";

const base = (portalName: any, over: Partial<PortalExtraction> = {}): PortalExtraction => normalizeAgentResult(portalName, {
  surveyNumberMatched: "42/2B", currentOwnerNames: [], mutationHistory: [], encumbrances: [], litigationCases: [], rawArtifactUrls: [], ...over
}, "42/2B");

describe("font transcoder", () => {
  it("converts Kruti Dev to Unicode with reph and short-i reordering", () => {
    expect(krutiDevToUnicode("jes'k dqekj 'kekZ")).toBe("रमेश कुमार शर्मा");
    expect(krutiDevToUnicode("fdlku")).toBe("किसान");
    expect(krutiDevToUnicode("eksgu")).toBe("मोहन");
  });
});

describe("transliteration + name resolution", () => {
  it("romanises Devanagari with schwa deletion", () => {
    expect(transliterate("रमेश कुमार शर्मा")).toBe("Ramesh Kumar Sharma");
  });
  it("romanises Kannada and Telugu", () => {
    expect(transliterate("ವೆಂಕಟೇಶ ಮೂರ್ತಿ").toLowerCase()).toBe("venkatesha murti");
    expect(transliterate("కల్వకుంట్ల రామా రావు").toLowerCase()).toBe("kalvakuntla rama ravu");
  });
  it("matches the PDF's name variants as the same person", () => {
    const a = "Ramesh Kumar Sharma";
    for (const b of ["रमेश कुमार शर्मा", "Ramesh K. Sharma", "Rameshkumar Sharma"]) {
      expect(compareNames(a, b).kind, b).not.toBe("mismatch");
    }
    expect(compareNames("Venkatesh Murthy", "ವೆಂಕಟೇಶ ಮೂರ್ತಿ").kind).not.toBe("mismatch");
    expect(compareNames("K. Rama Rao", "Kalvakuntla Rama Rao").kind).toBe("variance");
    expect(compareNames("Suresh Patil", "Ramesh Kumar Sharma").kind).toBe("mismatch");
  });
  it("uses the patronymic to separate namesakes", () => {
    expect(compareNames("Ramesh Sharma S/O Mohanlal Sharma", "Ramesh Sharma S/O Mohanlal Sharma").kind).toBe("exact");
    expect(compareNames("Ramesh Sharma S/O Mohanlal Sharma", "Ramesh Sharma S/O Gopal Verma").kind).toBe("mismatch");
  });
  it("phonetic keys collapse transliteration variants", () => {
    expect(phoneticKey("Murthy")).toBe(phoneticKey("Murti"));
    expect(phoneticKey("Lakshmi")).toBe(phoneticKey("Laxmi"));
  });
});

describe("mortgage release matching", () => {
  it("pairs releases by lender + reference and flags the rest", () => {
    const ec = base("KAVERI_KA", { encumbrances: [
      { documentNumber: "4410/2015", registrationDate: "2015-07-02", transactionNature: "Mortgage by deposit of title deeds", lenderOrClaimantName: "SBI", loanReference: "LN-77310", isActiveLien: false, loanAmountINR: 2500000 },
      { documentNumber: "2291/2018", registrationDate: "2018-11-20", transactionNature: "Discharge receipt", lenderOrClaimantName: "State Bank of India", loanReference: "LN-77310", isActiveLien: false, loanAmountINR: null },
      { documentNumber: "2087/2025", registrationDate: "2025-06-11", transactionNature: "MODT", lenderOrClaimantName: "HDFC Bank Ltd", loanReference: "BL-55092", isActiveLien: true, loanAmountINR: 4800000 }
    ] as any });
    const f = matchMortgages([ec]);
    expect(f).toHaveLength(2);
    expect(f[0].released).toBe(true);
    expect(f[1].released).toBe(false);
    expect(f[1].lender).toBe("HDFC BANK");
  });
});

const cleanSet = (): PortalExtraction[] => [
  base("KAVERI_KA", { ecCoverageFromYear: 1990, encumbrances: [
    { documentNumber: "1874/2003", registrationDate: "2003-03-14", transactionNature: "Sale deed", executant: "Hanumanthappa", claimant: "Chikka Ramaiah", lenderOrClaimantName: null, isActiveLien: false, loanAmountINR: 900000 },
    { documentNumber: "3356/2019", registrationDate: "2019-09-05", transactionNature: "Sale deed", executant: "Lakshmamma R", claimant: "Venkatesh Murthy S/O Narayana Murthy", lenderOrClaimantName: null, isActiveLien: false, loanAmountINR: 9000000 }
  ] as any }),
  base("BHOOMI_KA", { currentOwnerNames: ["ವೆಂಕಟೇಶ ಮೂರ್ತಿ"], mutationHistory: [
    { mutationNumber: "MR 14/2003-04", mutationDate: "2003-06-10", transferType: "SALE", transferor: "Hanumanthappa", transferee: "Chikka Ramaiah", isVerified: true },
    { mutationNumber: "MR 9/2012-13", mutationDate: "2012-08-22", transferType: "INHERITANCE", transferor: "Chikka Ramaiah", transferee: "Lakshmamma R", isVerified: true },
    { mutationNumber: "MR 31/2019-20", mutationDate: "2019-12-03", transferType: "SALE", transferor: "Lakshmamma R", transferee: "Venkatesh Murthy", isVerified: true }
  ] as any }),
  base("ECOURTS_NJDG"),
  base("CERSAI")
];

describe("chain of title", () => {
  it("is continuous when every transferor acquired earlier", () => {
    const c = buildChain(cleanSet(), new Date("2026-10-20"));
    expect(c.continuous).toBe(true);
    expect(c.links.length).toBe(3);
    expect(c.mutationLagging).toBe(false);
  });
  it("flags a break when an owner appears from nowhere", () => {
    const set = cleanSet();
    set[1].mutationHistory.splice(1, 1); // remove the 2012 inheritance
    const c = buildChain(set, new Date("2026-10-20"));
    expect(c.continuous).toBe(false);
    expect(c.breaks[0].owner).toBe("Lakshmamma R");
  });
});

describe("deterministic scoring (PDF §5.2)", () => {
  const asOf = new Date("2026-10-20");
  it("clean title scores 100 and releases escrow", () => {
    const a = assessTitle({ extractions: cleanSet(), surveyNumber: "42/2B", claimedOwnerName: "Venkatesh Murthy", asOf });
    expect(a.score).toBe(100);
    expect(a.verdict).toBe("CLEAN_TITLE");
    expect(a.escrowAction).toBe("RELEASE_TO_SELLER");
  });
  it("an active CERSAI charge is a hard veto (S = 0, refund)", () => {
    const set = cleanSet();
    set[3].encumbrances.push({ documentNumber: "SI-400118223", registrationDate: "2025-06-14", transactionNature: "Security interest (mortgage)", lenderOrClaimantName: "HDFC Bank", isActiveLien: true, loanAmountINR: 4800000 } as any);
    const a = assessTitle({ extractions: set, surveyNumber: "42/2B", claimedOwnerName: "Venkatesh Murthy", asOf });
    expect(a.score).toBe(0);
    expect(a.verdict).toBe("REJECTED");
    expect(a.escrowAction).toBe("REFUND_TO_BUYER");
  });
  it("a stay order on the survey number vetoes", () => {
    const set = cleanSet();
    set[2].litigationCases.push({ cnrNumber: "KABL010118742025", caseType: "O.S. partition", filingDate: "2025-02-17", courtName: "City Civil Court", petitioner: "Lakshmamma R", respondent: "Venkatesh Murthy", currentStatus: "Pending - interim injunction granted", hasStayOrInjunction: true, matchedBy: "SURVEY_NUMBER" } as any);
    const a = assessTitle({ extractions: set, surveyNumber: "42/2B", claimedOwnerName: "Venkatesh Murthy", asOf });
    expect(a.rules.find((r) => r.id === "V2")!.hit).toBe(true);
    expect(a.score).toBe(0);
  });
  it("soft deductions land in the advocate review band", () => {
    const set = cleanSet();
    set[0].ecCoverageFromYear = 2002;                        // −20
    set[1].mutationHistory.pop();                             // mutation lag −15
    set[1].currentOwnerNames = ["Lakshmamma R"];
    set[2].litigationCases.push({ cnrNumber: "KABL010043212010", caseType: "O.S. injunction", filingDate: "2010-04-08", courtName: "Civil Judge", petitioner: "Neighbour", respondent: "Lakshmamma R", currentStatus: "Dismissed", disposalDate: "2012-01-10", matchedBy: "PARTY_NAME" } as any); // −10
    const a = assessTitle({ extractions: set, surveyNumber: "42/2B", claimedOwnerName: "Venkatesh Murthy", asOf });
    expect(a.rawScore).toBe(55);
    expect(a.verdict).toBe("CONDITIONAL_REVIEW");
    expect(a.escrowAction).toBe("DISPUTE_HOLD");
  });
  it("restricted land vetoes", () => {
    const set = cleanSet();
    set[1].otherRightsAndLiabilities = ["PTCL — granted land, transfer prohibited"];
    expect(assessTitle({ extractions: set, surveyNumber: "42/2B", asOf }).verdict).toBe("REJECTED");
  });
  it("a seller who isn't the owner can never auto-clear", () => {
    const a = assessTitle({ extractions: cleanSet(), surveyNumber: "42/2B", claimedOwnerName: "Suresh Patil", asOf });
    expect(a.score).toBe(89);
    expect(a.verdict).toBe("CONDITIONAL_REVIEW");
  });
});

describe("ledger + merkle", () => {
  it("detects tampering in the hash chain", () => {
    const ts = "2026-10-20T10:00:00.000Z";
    const h1 = ledgerRowHash(GENESIS_HASH, "TCC-1", "p1", "e1", ts);
    const h2 = ledgerRowHash(h1, "TCC-2", "p2", "e2", ts);
    const rows = [
      { sequence_no: 1, certificate_id: "TCC-1", previous_row_hash: GENESIS_HASH, current_row_hash: h1, property_hash: "p1", evidence_hash: "e1", recorded_at_iso: ts },
      { sequence_no: 2, certificate_id: "TCC-2", previous_row_hash: h1, current_row_hash: h2, property_hash: "p2", evidence_hash: "e2", recorded_at_iso: ts }
    ];
    expect(verifyLedger(rows).ok).toBe(true);
    rows[0].evidence_hash = "tampered";
    expect(verifyLedger(rows)).toMatchObject({ ok: false, brokenAt: 1 });
  });
  it("produces verifiable inclusion proofs", () => {
    const leaves = ["a", "b", "c", "d", "e"].map((x) => Buffer.from(x.repeat(32)).toString("hex").slice(0, 64));
    const root = merkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) expect(verifyMerkleProof(leaves[i], merkleProof(leaves, i), root)).toBe(true);
  });
});

describe("geo resolver", () => {
  it("parses the PDF example address", () => {
    const r = resolveAddress("Plot 42/B, Gachibowli, Serilingampally, Ranga Reddy, Telangana");
    expect(r).toMatchObject({ stateCode: "TS", district: "Ranga Reddy", taluk: "Serilingampally", village: "Gachibowli", surveyNumber: "42/B" });
  });
});

describe("vernacular regressions", () => {
  it("medial schwa deletion", () => {
    expect(transliterate("मोहनलाल").toLowerCase()).toBe("mohanlal");
    expect(transliterate("सुखबीर सिंह").toLowerCase()).toBe("sukhbir singh");
    expect(transliterate("देशमुख").toLowerCase()).toBe("deshmukh");
    expect(transliterate("कमल").toLowerCase()).toBe("kamal");
  });
  it("Kruti Dev Khatauni names decode and match their English EC spelling", () => {
    expect(krutiDevToUnicode("jes'k dqekj 'kekZ iq= eksguyky 'kekZ")).toBe("रमेश कुमार शर्मा पुत्र मोहनलाल शर्मा");
    expect(krutiDevToUnicode("lq[kchj flag")).toBe("सुखबीर सिंह");
    expect(compareNames("Ramesh Kumar Sharma S/O Mohanlal Sharma", "रमेश कुमार शर्मा पुत्र मोहनलाल शर्मा").kind).toBe("exact");
  });
  it("spelled-out Indic initials", () => {
    expect(compareNames("Lakshmamma R", "ಲಕ್ಷ್ಮಮ್ಮ ಆರ್").kind).not.toBe("mismatch");
    expect(compareNames("B. Sujatha", "బి. సుజాత").kind).not.toBe("mismatch");
  });
});

describe("legacy font detection", () => {
  it("spots Kruti Dev but leaves English names alone", async () => {
    const { looksLikeKrutiDev } = await import("../src/index.ts");
    for (const k of ["jes'k dqekj 'kekZ", "lq[kchj flag", "eksguyky 'kekZ", "jke fd'ku"]) expect(looksLikeKrutiDev(k), k).toBe(true);
    for (const e of ["Ramesh Kumar Sharma", "Kalvakuntla Rama Rao", "B. Narsimha", "Sukhbir Singh", "Hanumanthappa", "Venkatesh Murthy"]) expect(looksLikeKrutiDev(e), e).toBe(false);
  });
});

describe("south Indian spelling variants", () => {
  it("Ramaiah/Ramayya, Rao/Ravu, Narsimha", () => {
    expect(compareNames("Chikka Ramaiah", "ಚಿಕ್ಕ ರಾಮಯ್ಯ").kind).not.toBe("mismatch");
    expect(compareNames("K. Rama Rao", "కల్వకుంట్ల రామా రావు").kind).not.toBe("mismatch");
    expect(compareNames("B. Narsimha", "బి. నర్సింహ").kind).not.toBe("mismatch");
    expect(compareNames("M. Laxmaiah", "ఎం. లక్ష్మయ్య").kind).not.toBe("mismatch");
  });
});

describe("page matching (free-tier web evidence)", async () => {
  const { findSurvey, findPlace, findPerson, matchPage, surveyRegex } = await import("../src/index.ts");
  it("finds survey numbers only with a survey keyword", () => {
    expect(findSurvey("land bearing Sy. No. 42/2B of Hebbal village", "42/2B")).toMatchObject({ found: true, withKeyword: true });
    expect(findSurvey("in Survey No.42 / 2-B situated at", "42/2B").withKeyword).toBe(true);
    expect(findSurvey("page 42/2B of the record", "42/2B")).toMatchObject({ found: true, withKeyword: false });
    expect(findSurvey("Sy. No. 42/2B1 of Hebbal", "42/2B").found).toBe(false);
    expect(findSurvey("Khasra No. 312, Kondli", "312").withKeyword).toBe(true);
    expect(findSurvey("Rs. 312 only", "312").withKeyword).toBe(false);
    expect(surveyRegex("")).toBeNull();
  });
  it("finds places exactly or phonetically", () => {
    expect(findPlace("situated at Hebbala village, Bengaluru North", "Hebbal").found).toBe(true);
    expect(findPlace("at White Field, Bangalore", "Whitefield").found).toBe(true);
    expect(findPlace("Koramangala 4th block", "Hebbal").found).toBe(false);
  });
  it("finds a person's name in running text", () => {
    expect(findPerson("Venkatesh Murthy S/O Narayana Murthy ... Petitioner", "Venkatesh Murthy").found).toBe(true);
    expect(findPerson("Suresh Patil and others", "Venkatesh Murthy").found).toBe(false);
  });
  it("grades evidence strength", () => {
    expect(matchPage("Possession notice for Sy. No. 42/2B, Hebbal village", { survey: "42/2B", village: "Hebbal", district: "Bengaluru Urban" }).strength).toBe("STRONG");
    expect(matchPage("Borrower: Venkatesh Murthy, Hebbal, Bengaluru", { survey: "42/2B", village: "Hebbal", owner: "Venkatesh Murthy" }).strength).toBe("MEDIUM");
    expect(matchPage("Venkatesh Murthy won an award", { village: "Hebbal", owner: "Venkatesh Murthy" }).strength).toBe("WEAK");
    expect(matchPage("unrelated page", { village: "Hebbal", owner: "Venkatesh Murthy" }).strength).toBe("NONE");
  });
});

describe("deterministic extractors", async () => {
  const { extractCase, extractNotice, extractRestriction, parseEcText, parseRorText, parseIndianDate, stateCodeFromName } = await import("../src/index.ts");
  it("parses Indian dates", () => {
    expect(parseIndianDate("dated 05-07-2015")).toBe("2015-07-05");
    expect(parseIndianDate("on 3 June, 2015")).toBe("2015-06-03");
  });
  it("reads a judgment page", () => {
    const c = extractCase("IN THE HIGH COURT OF KARNATAKA ... O.S. No. 214/2019 ... suit for permanent injunction over Sy. No. 42/2B ... The suit is dismissed.", "Lakshmamma R vs Venkatesh Murthy on 12 March, 2021", "https://indiankanoon.org/doc/1/");
    expect(c.petitioner).toBe("Lakshmamma R");
    expect(c.respondent).toBe("Venkatesh Murthy");
    expect(c.date).toBe("2021-03-12");
    expect(c.disposed).toBe(true);
    const p = extractCase("Interim injunction granted restraining the defendants from alienating the suit schedule property. List after two weeks.", "A vs B", "https://x.gov.in/a");
    expect(p.stay).toBe(true);
    expect(p.disposed).toBe(false);
  });
  it("reads a SARFAESI notice", () => {
    const n = extractNotice("HDFC Bank Ltd. POSSESSION NOTICE ... Borrower: Ramesh Kumar Sharma ... outstanding amount of Rs. 48,00,000 ... Date: 14.06.2025");
    expect(n).toMatchObject({ kind: "SARFAESI possession notice", lender: "HDFC BANK", date: "2025-06-14", amountINR: 4800000 });
  });
  it("spots government restrictions", () => {
    expect(extractRestriction("Preliminary notification under section 11(1) of the RFCTLARR Act for Sy. No. 78/3.")?.sentence).toContain("RFCTLARR");
    expect(extractRestriction("A nice residential layout.")).toBeNull();
  });
  it("parses English Encumbrance Certificate text", () => {
    const ec = parseEcText(`Encumbrance Certificate for the period from 01-01-1996 to 20-10-2026
1. Document No 3356/2019 Date 05-09-2019 Nature: Sale Deed Executant: Lakshmamma R Claimant: Venkatesh Murthy Consideration Rs. 92,00,000
2. Document No 5102/2020 Date 18-02-2020 Nature: Mortgage by deposit of title deeds Executant: Venkatesh Murthy Claimant: Canara Bank Loan No HL-20418 Rs. 40,00,000
3. Document No 1167/2024 Date 30-01-2024 Nature: Release deed Executant: Canara Bank Claimant: Venkatesh Murthy Loan No HL-20418`);
    expect(ec.coverageFromYear).toBe(1996);
    expect(ec.entries).toHaveLength(3);
    expect(ec.entries[1]).toMatchObject({ documentNumber: "5102/2020", lenderOrClaimantName: "CANARA BANK", loanReference: "HL-20418" });
  });
  it("parses RoR text and state names", () => {
    const r = parseRorText("Owner Name: Venkatesh Murthy\nExtent: 1 acre 12 guntas\nOther rights: Canara Bank loan closed");
    expect(r.owners).toEqual(["Venkatesh Murthy"]);
    expect(stateCodeFromName("Orissa")).toBe("OD");
    expect(stateCodeFromName("National Capital Territory of Delhi")).toBe("DL");
    expect(stateCodeFromName("Telangana")).toBe("TS");
  });
});
