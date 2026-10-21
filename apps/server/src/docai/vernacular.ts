import { detectScript, krutiDevToUnicode, looksLikeKrutiDev, transliterate, isIndic, type PortalExtraction } from "@titleshield/core";

/**
 * Stage 1 of the vernacular pipeline applied to every agent result (PDF §4.1):
 * decode legacy-font text to Unicode, detect scripts, and attach romanisations
 * used for display and entity resolution. Deterministic; runs in < 1 ms per record.
 */

export interface VernacularReport {
  scripts: string[];
  legacyFontFields: Array<{ field: string; original: string; unicode: string }>;
  transliterations: Array<{ original: string; latin: string }>;
}

export function normalizeVernacular(x: PortalExtraction): { extraction: PortalExtraction; report: VernacularReport } {
  const scripts = new Set<string>();
  const legacy: VernacularReport["legacyFontFields"] = [];
  const translit = new Map<string, string>();

  const fix = (field: string, v: string | null | undefined): string | null | undefined => {
    if (!v) return v;
    let out = v;
    if (looksLikeKrutiDev(v)) {
      out = krutiDevToUnicode(v);
      legacy.push({ field, original: v, unicode: out });
    }
    const sc = detectScript(out);
    if (sc !== "Unknown") scripts.add(sc);
    if (isIndic(out)) translit.set(out, transliterate(out));
    return out;
  };

  const e: PortalExtraction = {
    ...x,
    currentOwnerNames: x.currentOwnerNames.map((n, i) => fix(`currentOwnerNames[${i}]`, n) as string),
    mutationHistory: x.mutationHistory.map((m, i) => ({
      ...m,
      transferor: fix(`mutationHistory[${i}].transferor`, m.transferor) as string,
      transferee: fix(`mutationHistory[${i}].transferee`, m.transferee) as string
    })),
    encumbrances: x.encumbrances.map((en, i) => ({
      ...en,
      executant: fix(`encumbrances[${i}].executant`, en.executant ?? null) ?? null,
      claimant: fix(`encumbrances[${i}].claimant`, en.claimant ?? null) ?? null
    })),
    litigationCases: x.litigationCases.map((c, i) => ({
      ...c,
      petitioner: fix(`litigationCases[${i}].petitioner`, c.petitioner) as string,
      respondent: fix(`litigationCases[${i}].respondent`, c.respondent) as string
    })),
    otherRightsAndLiabilities: (x.otherRightsAndLiabilities ?? []).map((t, i) => fix(`otherRightsAndLiabilities[${i}]`, t) as string)
  };
  return {
    extraction: e,
    report: { scripts: [...scripts], legacyFontFields: legacy, transliterations: [...translit].map(([original, latin]) => ({ original, latin })) }
  };
}
