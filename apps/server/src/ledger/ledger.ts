import { GENESIS_HASH, ledgerRowHash, merkleProof, merkleRoot, verifyLedger, verifyMerkleProof, type LedgerRow } from "@titleshield/core";
import { one, q, tx } from "../db/pool.ts";
import { timestamp } from "../certs/tsa.ts";
import { config } from "../config.ts";

/** Append-only hash-chained certificate ledger + hourly Merkle anchors (PDF §7.2). */

export interface AppendInput {
  certificateId: string;
  searchId: string;
  escrowId: string | null;
  payload: object;
  documentType: string;
  propertyHash: string;
  evidenceHash: string;
  pdfSha256: string;
  pdfUri: string;
  signerSerial: string;
}

export async function appendToLedger(i: AppendInput) {
  return tx(async (c) => {
    // Serialise appends so each row links to exactly one predecessor.
    await c.query("SELECT pg_advisory_xact_lock(727274)");
    const prev = (await c.query("SELECT current_row_hash FROM immutable_certificate_ledger ORDER BY sequence_no DESC LIMIT 1")).rows[0];
    const prevHash = prev?.current_row_hash ?? GENESIS_HASH;
    const ts = new Date().toISOString();
    const hash = ledgerRowHash(prevHash, i.certificateId, i.propertyHash, i.evidenceHash, ts);
    const r = await c.query(
      `INSERT INTO immutable_certificate_ledger (certificate_id, search_id, escrow_id, payload_canonical_json, previous_row_hash, current_row_hash,
         document_type, property_hash, evidence_hash, recorded_at_iso, pdf_sha256, pdf_storage_uri, signer_serial, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING sequence_no`,
      [i.certificateId, i.searchId, i.escrowId, JSON.stringify(i.payload), prevHash, hash, i.documentType, i.propertyHash, i.evidenceHash, ts, i.pdfSha256, i.pdfUri, i.signerSerial, ts]
    );
    return { sequenceNo: Number(r.rows[0].sequence_no), previousHash: prevHash, currentHash: hash, recordedAt: ts };
  });
}

async function allRows(): Promise<(LedgerRow & { recorded_at: Date })[]> {
  return q(`SELECT sequence_no, certificate_id, previous_row_hash, current_row_hash, property_hash, evidence_hash, recorded_at_iso, recorded_at
            FROM immutable_certificate_ledger ORDER BY sequence_no`);
}

export async function verifyWholeLedger() {
  const rows = await allRows();
  const res = verifyLedger(rows);
  return { ...res, head: rows.length ? rows[rows.length - 1].current_row_hash : GENESIS_HASH };
}

/** Anchor every completed hour that has certificates and no anchor yet. */
export async function anchorPendingHours() {
  const rows = await allRows();
  const byHour = new Map<string, typeof rows>();
  for (const r of rows) {
    const h = new Date(r.recorded_at); h.setUTCMinutes(0, 0, 0);
    const k = h.toISOString();
    if (!byHour.has(k)) byHour.set(k, []);
    byHour.get(k)!.push(r);
  }
  const currentHour = new Date(); currentHour.setUTCMinutes(0, 0, 0);
  const anchored = new Set((await q("SELECT period_start FROM merkle_anchors")).map((r) => new Date(r.period_start).toISOString()));
  const created: any[] = [];
  for (const [hour, items] of byHour) {
    if (anchored.has(hour) || new Date(hour) >= currentHour) continue;
    created.push(await anchorPeriod(new Date(hour), items));
  }
  return created;
}

/** Anchor the given hour now (used for the open hour on demand). */
export async function anchorHour(start: Date, force = false) {
  const end = new Date(start.getTime() + 3600_000);
  const items = (await allRows()).filter((r) => new Date(r.recorded_at) >= start && new Date(r.recorded_at) < end);
  if (!items.length) return null;
  if (force) await q("DELETE FROM merkle_anchors WHERE period_start = $1", [start]);
  return anchorPeriod(start, items);
}

async function anchorPeriod(start: Date, items: Array<LedgerRow & { recorded_at: Date }>) {
  const root = merkleRoot(items.map((r) => r.current_row_hash));
  const tsa = await timestamp(root);
  const row = await one(
    `INSERT INTO merkle_anchors (period_start, period_end, first_sequence, last_sequence, leaf_count, merkle_root, tsa_url, tsa_rfc3161_token, tsa_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (period_start) DO NOTHING RETURNING *`,
    [start, new Date(start.getTime() + 3600_000), items[0].sequence_no, items[items.length - 1].sequence_no, items.length, root, config.TSA_URL, tsa.token, tsa.status]
  );
  return row;
}

/** Everything a verifier needs for one certificate: chain position, Merkle inclusion, anchor. */
export async function certificateProof(certificateId: string) {
  const row = await one("SELECT * FROM immutable_certificate_ledger WHERE certificate_id = $1", [certificateId]);
  if (!row) return null;
  const rows = await allRows();
  const upTo = rows.filter((r) => Number(r.sequence_no) <= Number(row.sequence_no));
  const chain = verifyLedger(upTo);
  const anchor = await one("SELECT * FROM merkle_anchors WHERE first_sequence <= $1 AND last_sequence >= $1", [row.sequence_no]);
  let merkle: any = null;
  if (anchor) {
    const leaves = rows.filter((r) => Number(r.sequence_no) >= Number(anchor.first_sequence) && Number(r.sequence_no) <= Number(anchor.last_sequence)).map((r) => r.current_row_hash);
    const idx = leaves.indexOf(row.current_row_hash);
    const proof = merkleProof(leaves, idx);
    merkle = { root: anchor.merkle_root, proof, verified: verifyMerkleProof(row.current_row_hash, proof, anchor.merkle_root), tsaStatus: anchor.tsa_status, tsaUrl: anchor.tsa_url, periodStart: anchor.period_start, hasTsaToken: !!anchor.tsa_rfc3161_token };
  }
  return { row, chainValidUpToThisRow: chain.ok, chainCheck: chain, merkle };
}
