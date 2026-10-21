/**
 * IndicSoundex-style phonetic key for romanised Indian names.
 * Collapses the spelling variants transliteration produces:
 * Murthy/Murti, Venkatesha/Venkatesh, Laxmi/Lakshmi, Sharma/Sarma, Vasu/Wasu.
 */
const RULES: Array<[RegExp, string]> = [
  // South Indian name endings: Ramaiah/Ramayya, Rao/Ravu/Raw
  [/^(mohammed|mohammad|muhammad|muhammed|mahammad|mohamed|mohamad|mohd|md)$/g, "mhmd"],
  [/(?:aiah|ayyah|ayya|aiya|aya)\b/g, "aya"], [/iah\b/g, "ya"], [/avu\b/g, "av"], [/ao\b/g, "av"], [/aw\b/g, "av"],
  [/ksh/g, "ks"], [/x/g, "ks"],
  [/chh/g, "c"], [/ch/g, "c"],
  [/sh/g, "s"], [/zh/g, "l"],
  [/ph/g, "f"], [/bh/g, "b"], [/dh/g, "d"], [/th/g, "t"], [/kh/g, "k"], [/gh/g, "g"], [/jh/g, "j"],
  [/w/g, "v"], [/z/g, "j"], [/q/g, "k"], [/c(?=[eiy])/g, "s"],
  [/ee/g, "i"], [/ii/g, "i"], [/oo/g, "u"], [/uu/g, "u"], [/aa/g, "a"],
  [/ou/g, "u"], [/au/g, "o"], [/ai/g, "e"], [/ei/g, "e"], [/ay/g, "e"],
  [/y\b/g, "i"], [/ri(?=[^aeiou]|$)/g, "r"],
  [/h/g, ""]
];

export function phoneticKey(token: string): string {
  let s = token.toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return "";
  for (const [re, rep] of RULES) s = s.replace(re, rep);
  s = s.replace(/(.)\1+/g, "$1");               // collapse doubled letters
  if (s.length > 3) s = s.replace(/[aeiou]+$/, ""); // trailing vowel (Venkatesha → venkates)
  return s;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** 1.0 = identical, 0.0 = nothing in common. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}
