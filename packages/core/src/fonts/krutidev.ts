/**
 * Font-Transcoder (PDF §4.1 stage 1): converts text encoded for the legacy
 * Kruti Dev 010 glyph font (common on UP/Bihar/MP revenue records) to Unicode
 * Devanagari. Deterministic, no network, sub-millisecond.
 *
 * Kruti Dev places the short-i matra ("f") before its consonant and the reph ("Z")
 * after its syllable; both are reordered here into Unicode logical order.
 */

// Longest sequences first. Letters built from a half-form plus the aa-stroke ("k")
// must be replaced before the bare "k" → "ा" rule.
const MAP: Array<[string, string]> = [
  ["vkS", "औ"], ["vks", "ओ"], ["vk", "आ"], [",s", "ऐ"], ["bZ", "ई"],
  ["[k", "ख"], ["?k", "घ"], ["Fk", "थ"], ["Hk", "भ"], ["'k", "श"], ["\"k", "ष"], [".k", "ण"], ["Vª", "ट्र"],
  ["Ø", "क्र"], ["Ðk", "द्ध"], ["Í", "ट्ट"], ["Î", "ट्ठ"], ["Ô", "त्त"], ["Ù", "त्त्"], ["ê", "ह्न"], ["ã", "ह्म"],
  ["{k", "क्ष"], ["K", "ज्ञ"], ["=", "त्र"], ["J", "श्र"],
  ["ks", "ो"], ["kS", "ौ"],
  ["v", "अ"], ["b", "इ"], ["m", "उ"], ["Å", "ऊ"], [",", "ए"], ["_", "ऋ"],
  ["d", "क"], ["D", "क्"], ["[", "ख्"], ["x", "ग"], ["X", "ग्"], ["?", "घ्"], ["³", "ङ"],
  ["p", "च"], ["P", "च्"], ["N", "छ"], ["t", "ज"], ["T", "ज्"], [">", "झ"], ["¥", "ञ"],
  ["V", "ट"], ["B", "ठ"], ["M", "ड"], ["<", "ढ"], [".", "ण्"],
  ["r", "त"], ["R", "त्"], ["F", "थ्"], ["n", "द"], ["/", "ध"], ["è", "ध्"], ["u", "न"], ["U", "न्"],
  ["i", "प"], ["I", "प्"], ["Q", "फ"], ["c", "ब"], ["C", "ब्"], ["H", "भ्"], ["e", "म"], ["E", "म्"],
  [";", "य"], ["¸", "य्"], ["j", "र"], ["y", "ल"], ["Y", "ल्"], ["G", "ळ"], ["o", "व"], ["O", "व्"],
  ["'", "श्"], ["\"", "ष्"], ["l", "स"], ["L", "स्"], ["g", "ह"],
  ["k", "ा"], ["h", "ी"], ["q", "ु"], ["w", "ू"], ["`", "ृ"], ["s", "े"], ["S", "ै"],
  ["a", "ं"], ["¡", "ँ"], [":", "ः"], ["~", "्"], ["z", "्र"], ["A", "।"], ["-", "."], ["+", "़"]
];

const CONSONANT = /[क-हक़-य़]/;
const DEPENDENT = /[ा-ौंँ़ः]/;
const VIRAMA = "्";

export function krutiDevToUnicode(input: string): string {
  // 1) glyph substitution, preserving markers for the two reordering rules
  let s = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === "f") { s += "\u0000I"; i++; continue; }   // short-i marker
    if (input[i] === "Z") { s += "\u0000R"; i++; continue; }   // reph marker
    let hit = false;
    for (const [k, u] of MAP) {
      if (input.startsWith(k, i)) { s += u; i += k.length; hit = true; break; }
    }
    if (!hit) { s += input[i]; i++; }
  }

  // 2) short-i: move after the following consonant cluster (C(्C)*)
  const chars = Array.from(s);
  const out: string[] = [];
  for (let j = 0; j < chars.length; j++) {
    if (chars[j] === "\u0000" && chars[j + 1] === "I") {
      j += 2;
      const cluster: string[] = [];
      while (j < chars.length) {
        if (CONSONANT.test(chars[j])) {
          cluster.push(chars[j]);
          if (chars[j + 1] === VIRAMA && j + 2 < chars.length && CONSONANT.test(chars[j + 2])) {
            cluster.push(VIRAMA); j += 2; continue;
          }
          if (chars[j + 1] === "़") { cluster.push("़"); j++; }
          break;
        }
        cluster.push(chars[j]); j++;
      }
      out.push(...cluster, "ि");
      continue;
    }
    out.push(chars[j]);
  }

  // 3) reph: "र्" moves before the syllable it was typed after
  const res: string[] = [];
  for (let j = 0; j < out.length; j++) {
    if (out[j] === "\u0000" && out[j + 1] === "R") {
      j += 1;
      let k = res.length - 1;
      while (k >= 0 && DEPENDENT.test(res[k])) k--;             // skip matras
      while (k >= 2 && res[k - 1] === VIRAMA && CONSONANT.test(res[k - 2])) k -= 2; // conjunct
      if (k < 0) k = 0;
      res.splice(k, 0, "र", VIRAMA);
      continue;
    }
    res.push(out[j]);
  }
  return res.join("");
}

/**
 * Heuristic: ASCII text that is Kruti Dev glyph codes rather than English.
 * Kruti Dev words are typed in lower case and lean heavily on k/q/w/Z/f/'/" for
 * matras and half-forms, which English names rarely do.
 */
export function looksLikeKrutiDev(text: string): boolean {
  if (!text || /[\u0900-\u097F]/.test(text) || !/[a-z]/.test(text)) return false;
  const words = text.trim().split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
  if (!words.length) return false;
  const lowerStart = words.filter((w) => /^['"\[;a-z]/.test(w)).length / words.length;
  const letters = text.replace(/[^a-zA-Z'"\[\];~`]/g, "");
  const marks = (letters.match(/[kqwZfS'"\[;~`]/g) ?? []).length / Math.max(1, letters.length);
  const englishVowels = (letters.match(/[aeiouAEIOU]/g) ?? []).length / Math.max(1, letters.length);
  return lowerStart >= 0.6 && marks >= 0.2 && englishVowels < 0.35;
}

export const SUPPORTED_LEGACY_FONTS = {
  "Kruti Dev 010": { script: "Devanagari", states: ["UP", "BR", "MP", "RJ"], converter: krutiDevToUnicode },
} as const;
