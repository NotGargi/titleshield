import { phoneticKey } from "./names/phonetic.ts";
import { compareNames, parseName } from "./names/resolver.ts";

/**
 * Deciding whether a web page is really about THIS property. A page counts against
 * a title only on strong evidence; everything else is shown but not scored.
 *
 *   STRONG  survey number (with a survey keyword) + village/locality on the same page
 *   MEDIUM  owner's name + village/locality (or district) on the same page
 *   WEAK    only a name or only the place
 */

export type MatchStrength = "STRONG" | "MEDIUM" | "WEAK" | "NONE";

const SURVEY_KEYWORDS = String.raw`(?:survey|sy|s\.\s?no|s\s?no|r\.?\s?s\.?\s?no|re-?survey|khasra|khesra|gata|gat|plot|khata|khatian|dag|patta|cts|c\.t\.s|hissa|block|sr\.?\s?no|s\.?\s?f\.?\s?no|ts\.?\s?no|survey\s+number|sy\.?\s?no)`;

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Regex for a survey number tolerant of spacing/separators: 42/2B ≈ 42 / 2-B ≈ 42/2 B. */
export function surveyRegex(survey: string): RegExp | null {
  const s = (survey ?? "").trim().toUpperCase();
  if (!s || !/\d/.test(s)) return null;
  const parts = s.split(/\s*[\/\-]\s*|\s+/).filter(Boolean);
  const partRe = parts.map((p) => p.split(/(?<=\d)(?=[A-Z])|(?<=[A-Z])(?=\d)/).map(escapeRe).join(String.raw`\s*-?\s*`));
  return new RegExp(String.raw`(?<![A-Za-z0-9\/])` + partRe.join(String.raw`\s*[\/\-]\s*`) + String.raw`(?![A-Za-z0-9]|\s*\/\s*\d)`, "gi");
}

export interface SurveyMention { found: boolean; withKeyword: boolean; excerpt: string | null }

export function findSurvey(text: string, survey: string): SurveyMention {
  const re = surveyRegex(survey);
  if (!re || !text) return { found: false, withKeyword: false, excerpt: null };
  const kw = new RegExp(SURVEY_KEYWORDS + String.raw`[\s.:#\-]*(?:no\.?|number|nos\.?)?[\s.:#\-]*$`, "i");
  let first: SurveyMention = { found: false, withKeyword: false, excerpt: null };
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index! - 28), m.index!);
    const excerpt = text.slice(Math.max(0, m.index! - 120), m.index! + m[0].length + 120).replace(/\s+/g, " ").trim();
    if (kw.test(before)) return { found: true, withKeyword: true, excerpt };
    if (!first.found) first = { found: true, withKeyword: false, excerpt };
  }
  return first;
}

const words = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9ऀ-෿\s]/g, " ").split(/\s+/).filter(Boolean);

/** Place name on the page: exact phrase, or the same phonetic key (Hebbal ≈ Hebbala, Whitefield ≈ White Field). */
export function findPlace(text: string, place: string | null | undefined): { found: boolean; excerpt: string | null } {
  const p = (place ?? "").trim();
  if (p.length < 3 || !text) return { found: false, excerpt: null };
  const exact = new RegExp(String.raw`(?<![A-Za-z])` + escapeRe(p).replace(/\s+/g, String.raw`\s*`) + String.raw`(?![A-Za-z])`, "i");
  const m = exact.exec(text);
  if (m) return { found: true, excerpt: text.slice(Math.max(0, m.index - 100), m.index + p.length + 100).replace(/\s+/g, " ").trim() };
  const target = phoneticKey(p.replace(/\s+/g, ""));
  if (target.length < 4) return { found: false, excerpt: null };
  const w = words(text.slice(0, 200_000));
  const n = words(p).length;
  for (let i = 0; i < w.length; i++) {
    for (const len of [n, n + 1, Math.max(1, n - 1)]) {
      const chunk = w.slice(i, i + len).join("");
      if (chunk.length >= 4 && phoneticKey(chunk) === target) return { found: true, excerpt: w.slice(Math.max(0, i - 12), i + len + 12).join(" ") };
    }
  }
  return { found: false, excerpt: null };
}

/** Best match of a person's name anywhere in the text (sliding window + resolver). */
export function findPerson(text: string, name: string | null | undefined): { found: boolean; score: number; matched: string | null } {
  const target = parseName(name ?? "");
  if (target.tokens.length < 2 || !text) return { found: false, score: 0, matched: null };
  // Cheap pre-filter: the surname (last token) must occur phonetically.
  const w = text.slice(0, 120_000).split(/\s+/).filter(Boolean);
  const lastKey = phoneticKey(target.tokens[target.tokens.length - 1]);
  let best = { found: false, score: 0, matched: null as string | null };
  for (let i = 0; i < w.length; i++) {
    if (phoneticKey(w[i].replace(/[^A-Za-z]/g, "")) !== lastKey) continue;
    for (let len = Math.max(2, target.tokens.length - 1); len <= target.tokens.length + 1; len++) {
      const start = Math.max(0, i - len + 1);
      const cand = w.slice(start, i + 1).join(" ").replace(/[^A-Za-z.\s]/g, " ");
      const m = compareNames(name!, cand);
      if (m.score > best.score) best = { found: m.kind !== "mismatch", score: m.score, matched: cand.trim() };
    }
  }
  return best;
}

export interface PageMatch {
  strength: MatchStrength;
  reasons: string[];
  surveyExcerpt: string | null;
  placeExcerpt: string | null;
  personMatched: string | null;
}

export function matchPage(text: string, ctx: { survey?: string | null; village?: string | null; locality?: string | null; district?: string | null; owner?: string | null }): PageMatch {
  const reasons: string[] = [];
  const survey = ctx.survey ? findSurvey(text, ctx.survey) : { found: false, withKeyword: false, excerpt: null };
  const village = findPlace(text, ctx.village);
  const locality = ctx.locality && ctx.locality !== ctx.village ? findPlace(text, ctx.locality) : { found: false, excerpt: null };
  const place = village.found ? village : locality;
  const district = findPlace(text, ctx.district);
  const person = ctx.owner ? findPerson(text, ctx.owner) : { found: false, score: 0, matched: null };

  if (survey.found) reasons.push(survey.withKeyword ? `survey no. ${ctx.survey} mentioned` : `number ${ctx.survey} appears (no survey keyword)`);
  if (village.found) reasons.push(`village ${ctx.village} mentioned`);
  else if (locality.found) reasons.push(`locality ${ctx.locality} mentioned`);
  if (district.found) reasons.push(`district ${ctx.district} mentioned`);
  if (person.found) reasons.push(`owner name matched “${person.matched}” (${Math.round(person.score * 100)}%)`);

  let strength: MatchStrength = "NONE";
  if (survey.withKeyword && place.found) strength = "STRONG";
  else if (person.found && (place.found || district.found)) strength = "MEDIUM";
  else if (person.found || (survey.withKeyword && district.found) || place.found) strength = "WEAK";
  return { strength, reasons, surveyExcerpt: survey.excerpt, placeExcerpt: place.excerpt, personMatched: person.matched };
}
