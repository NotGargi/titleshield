import { isIndic, transliterate } from "./transliterate.ts";
import { phoneticKey, similarity } from "./phonetic.ts";

/**
 * Entity resolution for owner names across a 30-year chain of deeds (PDF §4.1 stage 2):
 * IndicSoundex + Levenshtein + patronymic (S/O, W/O, D/O) matching.
 */

export interface ParsedName {
  raw: string;
  latin: string;
  tokens: string[];
  relation: "S/O" | "W/O" | "D/O" | "C/O" | null;
  relative: ParsedName | null;
}

const HONORIFICS = new Set(["sri", "shri", "smt", "shrimati", "srimati", "mr", "mrs", "ms", "dr", "late", "kumari", "km", "thiru", "tmt", "sh"]);
const RELATION_RE = /(?:^|[\s,])(s\/o|w\/o|d\/o|c\/o|son of|wife of|daughter of|care of|bin|ಬಿನ್|पुत्र|पत्नी|पुत्री)(?=[\s,:.]|$)/i;

function relationCode(m: string): ParsedName["relation"] {
  const s = m.toLowerCase();
  if (s.startsWith("s") || s === "पुत्र" || s === "bin" || s === "ಬಿನ್") return "S/O";
  if (s.startsWith("w") || s === "पत्नी") return "W/O";
  if (s.startsWith("d") || s === "पुत्री") return "D/O";
  return "C/O";
}

function tokenize(latin: string): string[] {
  return latin
    .toLowerCase()
    .replace(/\./g, ". ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !HONORIFICS.has(t));
}

// Initials written out phonetically in Indic scripts ("ಆರ್" = R, "కే" = K, "एस" = S).
const SPELLED_INITIALS: Record<string, string> = {
  bi: "b", si: "c", di: "d", ef: "f", ji: "g", ech: "h", je: "j", ke: "k", el: "l", em: "m", en: "n",
  pi: "p", ar: "r", es: "s", ti: "t", yu: "u", vi: "v", vai: "y", jed: "z", ey: "a", e: "e"
};

export function parseName(raw: string): ParsedName {
  const text = (raw ?? "").trim();
  const m = text.match(RELATION_RE);
  let self = text, rel: string | null = null, relation: ParsedName["relation"] = null;
  if (m && m.index !== undefined) {
    self = text.slice(0, m.index);
    rel = text.slice(m.index + m[0].length);
    relation = relationCode(m[1]);
  }
  const indic = isIndic(self);
  const latin = indic ? transliterate(self) : self;
  let tokens = tokenize(latin);
  if (indic && tokens.length > 1) tokens = tokens.map((t) => SPELLED_INITIALS[t] ?? t);
  return {
    raw: text,
    latin: latin.trim().replace(/\s+/g, " "),
    tokens,
    relation,
    relative: rel && rel.trim() ? parseName(rel) : null
  };
}

export type NameMatchKind = "exact" | "variance" | "mismatch";
export interface NameMatch {
  kind: NameMatchKind;
  score: number;              // 0..1
  patronymicChecked: boolean;
  patronymicMatches: boolean | null;
  notes: string[];
}

type TokenHow = "exact" | "initial" | "phonetic" | "fuzzy" | "none";

function tokenScore(a: string, b: string): { score: number; how: TokenHow } {
  if (a === b) return { score: 1, how: "exact" };
  if (a.length === 1 || b.length === 1) {
    return a[0] === b[0] ? { score: 0.9, how: "initial" } : { score: 0, how: "none" };
  }
  const ka = phoneticKey(a), kb = phoneticKey(b);
  if (ka && ka === kb) return { score: 0.97, how: "phonetic" };
  const s = similarity(ka, kb);
  return s >= 0.75 ? { score: s * 0.9, how: "fuzzy" } : { score: 0, how: "none" };
}

interface TokenComparison { score: number; exact: boolean; phoneticOnly: boolean; notes: string[] }

function compareTokens(a: string[], b: string[]): TokenComparison {
  const notes: string[] = [];
  if (!a.length || !b.length) return { score: 0, exact: false, phoneticOnly: false, notes: ["empty name"] };

  const joinedA = phoneticKey(a.join("")), joinedB = phoneticKey(b.join(""));
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Set<number>();
  let total = 0, allExact = true, onlyExactOrPhonetic = true;
  for (const t of short) {
    let best = { score: 0, idx: -1, how: "none" as TokenHow };
    long.forEach((u, i) => {
      if (used.has(i)) return;
      const r = tokenScore(t, u);
      if (r.score > best.score) best = { score: r.score, idx: i, how: r.how };
    });
    if (best.idx >= 0) used.add(best.idx);
    if (best.how !== "exact") allExact = false;
    if (best.how !== "exact" && best.how !== "phonetic") onlyExactOrPhonetic = false;
    if (best.how === "initial") notes.push(`initial "${t}" expanded`);
    if (best.how === "fuzzy") notes.push(`"${t}" spelled differently`);
    total += best.score;
  }
  const extra = long.length - short.length;
  if (extra > 0) { allExact = false; onlyExactOrPhonetic = false; notes.push(`${extra} extra name part(s)`); }
  let score = total / short.length - extra * 0.05;

  if (joinedA && joinedA === joinedB && score < 0.95) {
    score = 0.95; allExact = false; onlyExactOrPhonetic = false; notes.push("compound name split differently");
  }
  return { score: Math.max(0, Math.min(1, score)), exact: allExact, phoneticOnly: onlyExactOrPhonetic && !allExact, notes };
}

export function compareNames(aRaw: string, bRaw: string): NameMatch {
  const a = parseName(aRaw), b = parseName(bRaw);
  const crossScript = isIndic(aRaw) !== isIndic(bRaw);
  const self = compareTokens(a.tokens, b.tokens);
  const notes = [...self.notes];
  if (crossScript) notes.push("matched across scripts");
  // Across scripts, a phonetic-identical rendering is the same spelling, not a variance.
  let selfExact = self.exact || (crossScript && self.phoneticOnly);
  if (!crossScript && self.phoneticOnly) notes.push("transliteration variance");

  let patronymicChecked = false, patronymicMatches: boolean | null = null, score = selfExact ? 1 : self.score;
  if (a.relative && b.relative) {
    patronymicChecked = true;
    const rel = compareTokens(a.relative.tokens, b.relative.tokens);
    const relExact = rel.exact || (crossScript && rel.phoneticOnly);
    patronymicMatches = rel.score >= 0.8;
    if (!patronymicMatches) { score = Math.min(score, 0.6); notes.push("father's/husband's name differs"); }
    else if (!relExact) { notes.push("patronymic spelling variance"); selfExact = false; }
    score = score * 0.8 + (relExact ? 1 : rel.score) * 0.2;
  }

  let kind: NameMatchKind;
  if (selfExact && (patronymicMatches ?? true) && score >= 0.999) kind = "exact";
  else if (score >= 0.8) kind = "variance";
  else kind = "mismatch";
  return { kind, score: Math.round(score * 1000) / 1000, patronymicChecked, patronymicMatches, notes };
}

export function sameParty(a: string, b: string): boolean {
  return compareNames(a, b).kind !== "mismatch";
}

/** Group name strings into identity clusters. Returns canonical name per input. */
export function clusterNames(names: string[]): Map<string, string> {
  const canon: string[] = [];
  const out = new Map<string, string>();
  for (const n of names) {
    if (!n) continue;
    const hit = canon.find((c) => sameParty(c, n));
    if (hit) out.set(n, hit);
    else { canon.push(n); out.set(n, n); }
  }
  return out;
}
