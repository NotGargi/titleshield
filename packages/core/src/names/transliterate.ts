/**
 * Indic script → Latin transliteration.
 *
 * The Unicode blocks for Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil,
 * Telugu, Kannada and Malayalam share one layout, so a single offset table
 * covers all nine scripts. Output is a plain ASCII romanisation tuned for name
 * matching (not a scholarly ISO 15919 rendering).
 */

const BLOCKS: Array<{ base: number; script: string; schwaDeletion: boolean }> = [
  { base: 0x0900, script: "Devanagari", schwaDeletion: true },
  { base: 0x0980, script: "Bengali", schwaDeletion: true },
  { base: 0x0a00, script: "Gurmukhi", schwaDeletion: true },
  { base: 0x0a80, script: "Gujarati", schwaDeletion: true },
  { base: 0x0b00, script: "Oriya", schwaDeletion: false },
  { base: 0x0b80, script: "Tamil", schwaDeletion: false },
  { base: 0x0c00, script: "Telugu", schwaDeletion: false },
  { base: 0x0c80, script: "Kannada", schwaDeletion: false },
  { base: 0x0d00, script: "Malayalam", schwaDeletion: false }
];

const VOWELS: Record<number, string> = {
  0x05: "a", 0x06: "a", 0x07: "i", 0x08: "i", 0x09: "u", 0x0a: "u", 0x0b: "ri", 0x0c: "li",
  0x0e: "e", 0x0f: "e", 0x10: "ai", 0x12: "o", 0x13: "o", 0x14: "au"
};
const CONSONANTS: Record<number, string> = {
  0x15: "k", 0x16: "kh", 0x17: "g", 0x18: "gh", 0x19: "ng",
  0x1a: "ch", 0x1b: "chh", 0x1c: "j", 0x1d: "jh", 0x1e: "ny",
  0x1f: "t", 0x20: "th", 0x21: "d", 0x22: "dh", 0x23: "n",
  0x24: "t", 0x25: "th", 0x26: "d", 0x27: "dh", 0x28: "n", 0x29: "n",
  0x2a: "p", 0x2b: "ph", 0x2c: "b", 0x2d: "bh", 0x2e: "m",
  0x2f: "y", 0x30: "r", 0x31: "r", 0x32: "l", 0x33: "l", 0x34: "zh", 0x35: "v",
  0x36: "sh", 0x37: "sh", 0x38: "s", 0x39: "h",
  0x58: "q", 0x59: "kh", 0x5a: "g", 0x5b: "z", 0x5c: "d", 0x5d: "dh", 0x5e: "f", 0x5f: "y"
};
// Long vowels are written single (Kumar, not Kumaar) — the conventional spelling on Indian IDs.
const MATRAS: Record<number, string> = {
  0x3e: "a", 0x3f: "i", 0x40: "i", 0x41: "u", 0x42: "u", 0x43: "ri", 0x44: "rii",
  0x46: "e", 0x47: "e", 0x48: "ai", 0x4a: "o", 0x4b: "o", 0x4c: "au", 0x57: "au"
};
const VIRAMA = 0x4d;
const NUKTA = 0x3c;
const SIGNS: Record<number, string> = { 0x01: "n", 0x02: "n", 0x03: "h" };

function blockOf(cp: number) {
  for (const b of BLOCKS) if (cp >= b.base && cp < b.base + 0x80) return b;
  return null;
}

export function detectScript(text: string): string {
  for (const ch of text) {
    const b = blockOf(ch.codePointAt(0)!);
    if (b) return b.script;
  }
  return /[a-z]/i.test(text) ? "Latin" : "Unknown";
}

export function isIndic(text: string): boolean {
  return detectScript(text) !== "Latin" && detectScript(text) !== "Unknown";
}

type Unit =
  | { t: "C"; c: string; v: string | null; inherent: boolean }   // consonant + vowel (null = virama)
  | { t: "V"; v: string }                                         // independent vowel
  | { t: "S"; s: string }                                         // anusvara / visarga / digits
  | { t: "O"; s: string };                                        // anything else

function transliterateWord(word: string): string {
  const units: Unit[] = [];
  let schwaDel = false;
  for (const ch of word) {
    const cp = ch.codePointAt(0)!;
    const b = blockOf(cp);
    if (!b) { units.push({ t: "O", s: ch }); continue; }
    schwaDel = b.schwaDeletion;
    const off = cp - b.base;
    const last = units[units.length - 1];
    if (off === NUKTA) continue;
    if (CONSONANTS[off] !== undefined) units.push({ t: "C", c: CONSONANTS[off], v: "a", inherent: true });
    else if (MATRAS[off] !== undefined && last?.t === "C") { last.v = MATRAS[off]; last.inherent = false; }
    else if (off === VIRAMA && last?.t === "C") { last.v = null; last.inherent = false; }
    else if (VOWELS[off] !== undefined) units.push({ t: "V", v: VOWELS[off] });
    else if (SIGNS[off] !== undefined) units.push({ t: "S", s: SIGNS[off] });
    else if (off >= 0x66 && off <= 0x6f) units.push({ t: "S", s: String(off - 0x66) });
  }

  // Hindi/Marathi-style schwa deletion, right to left: the inherent "a" is silent word-finally,
  // and medially when flanked by vowelled syllables (VC_CV), e.g. मोहनलाल → mohanlal.
  if (schwaDel) {
    const cons = units.filter((u): u is Extract<Unit, { t: "C" }> => u.t === "C");
    const hasVowel = (u: Unit | undefined) => !!u && (u.t === "V" || (u.t === "C" && u.v !== null));
    for (let i = units.length - 1; i >= 1; i--) {
      const u = units[i];
      if (u.t !== "C" || !u.inherent) continue;
      const next = units[i + 1];
      const isFinal = !next || next.t === "O";
      if (isFinal && cons.length > 1) { u.v = null; continue; }
      if (!isFinal && next.t === "C" && hasVowel(next) && hasVowel(units[i - 1]) && i < units.length - 2) {
        u.v = null;
      }
    }
  }
  // Anusvara is homorganic with the next consonant: सिंह → singh, कुंभ → kumbh.
  return units.map((u, i) => {
    if (u.t === "C") return u.c + (u.v ?? "");
    if (u.t === "V") return u.v;
    const next = units[i + 1];
    if (u.s === "n" && next?.t === "C") {
      // Hindi सिंह → Singh, but Telugu/Kannada సింహ → Simha
      if (/^h/.test(next.c)) return schwaDel ? "ng" : "m";
      if (/^[pbm]/.test(next.c)) return "m";
    }
    // Word-final anusvara: nasal vowel in Hindi (n), full "m" in the southern scripts (ఎం = em).
    if (u.s === "n" && (!next || next.t === "O") && !schwaDel) return "m";
    return u.s;
  }).join("");
}

export function transliterate(text: string): string {
  if (!isIndic(text)) return text;
  return text
    .split(/(\s+)/)
    .map((w) => (/\s+/.test(w) ? w : transliterateWord(w)))
    .join("")
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}
