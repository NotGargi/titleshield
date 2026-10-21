import { createHash } from "node:crypto";

/**
 * Tamper-evident audit ledger (PDF §7.2):
 *   Hₙ = SHA256(Hₙ₋₁ ‖ TCC_IDₙ ‖ PropertyHashₙ ‖ TinyFishEvidenceHashₙ ‖ Timestampₙ)
 * Fields are joined with "|" so field boundaries are unambiguous.
 */

export const GENESIS_HASH = "0".repeat(64);

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON (sorted keys) so the same payload always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function propertyHash(p: { state: string; district: string; taluk: string; village: string; surveyNumber: string }): string {
  return sha256Hex([p.state, p.district, p.taluk, p.village, p.surveyNumber].map((s) => s.trim().toUpperCase()).join("|"));
}

export function ledgerRowHash(prev: string, certificateId: string, propHash: string, evidenceHash: string, timestampIso: string): string {
  return sha256Hex([prev, certificateId, propHash, evidenceHash, timestampIso].join("|"));
}

export interface LedgerRow {
  sequence_no: number | string;
  certificate_id: string;
  previous_row_hash: string;
  current_row_hash: string;
  property_hash: string;
  evidence_hash: string;
  recorded_at_iso: string;
}

/** Recompute the whole chain. Returns the first broken sequence number, if any. */
export function verifyLedger(rows: LedgerRow[]): { ok: boolean; checked: number; brokenAt: number | null; reason: string | null } {
  let prev = GENESIS_HASH;
  for (const r of rows) {
    if (r.previous_row_hash !== prev) return { ok: false, checked: rows.length, brokenAt: Number(r.sequence_no), reason: "previous_row_hash does not link to the prior row" };
    const h = ledgerRowHash(prev, r.certificate_id, r.property_hash, r.evidence_hash, r.recorded_at_iso);
    if (h !== r.current_row_hash) return { ok: false, checked: rows.length, brokenAt: Number(r.sequence_no), reason: "row contents were modified after recording" };
    prev = h;
  }
  return { ok: true, checked: rows.length, brokenAt: null, reason: null };
}

/** Merkle root over hex leaf hashes (PDF §7.2 hourly anchor). Odd node is paired with itself. */
export function merkleRoot(leaves: string[]): string {
  if (!leaves.length) return GENESIS_HASH;
  let level: Buffer[] = leaves.map((h) => Buffer.from(h, "hex"));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i], r = level[i + 1] ?? level[i];
      next.push(createHash("sha256").update(Buffer.concat([l, r])).digest());
    }
    level = next;
  }
  return level[0].toString("hex");
}

export function merkleProof(leaves: string[], index: number): Array<{ sibling: string; position: "left" | "right" }> {
  const proof: Array<{ sibling: string; position: "left" | "right" }> = [];
  let level: Buffer[] = leaves.map((h) => Buffer.from(h, "hex"));
  let idx = index;
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const sib = isRight ? level[idx - 1] : level[idx + 1] ?? level[idx];
    proof.push({ sibling: sib.toString("hex"), position: isRight ? "left" : "right" });
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i], r = level[i + 1] ?? level[i];
      next.push(createHash("sha256").update(Buffer.concat([l, r])).digest());
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyMerkleProof(leaf: string, proof: ReturnType<typeof merkleProof>, root: string): boolean {
  let h = Buffer.from(leaf, "hex");
  for (const p of proof) {
    const s = Buffer.from(p.sibling, "hex");
    h = createHash("sha256").update(p.position === "left" ? Buffer.concat([s, h]) : Buffer.concat([h, s])).digest();
  }
  return h.toString("hex") === root;
}
