import { STATES, stateCodeFromName } from "./portals.ts";

/**
 * Geo-Hierarchy Resolver (PDF §3.1, district-rent-shark pattern): turns a free-text
 * address like "Plot 42/B, Gachibowli, Serilingampally, Ranga Reddy, Telangana"
 * into the canonical hierarchy the portal dropdowns expect.
 */


export interface ResolvedAddress {
  stateCode: string | null;
  district: string | null;
  taluk: string | null;
  village: string | null;
  surveyNumber: string | null;
  confidence: number;
}

const SURVEY_RE = /\b(?:survey|sy|s\.?\s?no|khasra|gata|gat|plot|block|khata|hissa)\.?\s*(?:no\.?|number|#)?\s*[:\-]?\s*([0-9]+[0-9A-Za-z\/\-]*)/i;

const title = (s: string) => s.trim().replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function resolveAddress(text: string): ResolvedAddress {
  const parts = text.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
  let stateCode: string | null = null;
  let surveyNumber: string | null = null;
  const rest: string[] = [];
  for (const p of parts) {
    const low = p.toLowerCase().replace(/\s*\d{6}$/, "").trim(); // drop PIN code
    const sc: string | null = !stateCode ? (stateCodeFromName(low) ?? (STATES[p.toUpperCase()] ? p.toUpperCase() : null)) : null;
    if (sc) { stateCode = sc; continue; }
    const m = p.match(SURVEY_RE);
    if (!surveyNumber && m) { surveyNumber = m[1]; continue; }
    if (/^\d{6}$/.test(p)) continue;
    rest.push(title(p.replace(/\b(district|dist|taluk|taluka|tehsil|mandal|village|vill|gram)\b\.?/gi, "")));
  }
  // Addresses are written smallest-first: village, taluk/mandal, district.
  const [village = null, taluk = null, district = null] = rest.length >= 3 ? rest.slice(-3) : rest.length === 2 ? [rest[0], null, rest[1]] : [rest[0] ?? null, null, null];
  const found = [stateCode, district, taluk, village, surveyNumber].filter(Boolean).length;
  return { stateCode, district, taluk, village, surveyNumber, confidence: found / 5 };
}
