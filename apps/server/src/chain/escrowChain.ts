import crypto from "node:crypto";
import { ethers } from "ethers";
import { canonicalJson, STATES } from "@titleshield/core";
import { one, q } from "../db/pool.ts";
import {
  ChainError, STATUS, bytes32OfSha256, chainCtx, chainEnabled, chainTxs, ensureGas, escrowKey, explain, fromUnits, keccak,
  partyWallet, searchKey, send, toUnits, type ChainCtx, type SentTx
} from "./chain.ts";
import { buildVerdict, recoverSigner, signVerdict, verdictTuple, type Outcome, type Verdict } from "./attestation.ts";
import { config } from "../config.ts";

/**
 * TitleEscrow smart contract ↔ escrow workflow.
 *   both parties e-sign       → createEscrow()    terms, seller wallet and search id registered on-chain
 *   buyer deposits test tokens → deposit()        tokens move from the buyer's wallet into the contract
 *   title search starts        → beginVerification()
 *   verdict                    → settle(attestation)  the oracle signs; the contract verifies and then
 *                                  releases (clean), refunds (qualifying defect) or holds (inconclusive)
 */

async function escrowRow(escrowId: string) {
  return one(`SELECT e.*, s.state_code, s.district_name, s.village_name, s.survey_number, s.address_text, s.verdict, s.assessment, s.encumbrance_clearance_score
              FROM title_escrow_contracts e JOIN title_searches s USING (search_id) WHERE e.escrow_id = $1`, [escrowId]);
}

const propertyText = (e: any) => [e.address_text, e.survey_number && `Survey ${e.survey_number}`, e.village_name, e.district_name, STATES[e.state_code]?.name].filter(Boolean).join(", ");

export async function readOnChain(c: ChainCtx, escrowId: string) {
  const s = await c.escrow.escrows(escrowKey(escrowId));
  return { raw: s, status: STATUS[Number(s.status)], buyer: s.buyer as string, seller: s.seller as string, amount: fromUnits(s.amount), fee: fromUnits(s.fee) };
}

/** Registers the escrow on chain if it isn't yet (idempotent; re-registers after a local chain reset). */
export async function ensureOnChain(escrowId: string): Promise<SentTx | null> {
  if (!chainEnabled()) return null;
  const c = await chainCtx();
  const e = await escrowRow(escrowId);
  if (!e) throw new ChainError("Escrow not found");
  const seller = (e.seller_wallet?.trim() || partyWallet(c, escrowId, "seller").address);
  let sent: SentTx | null = null;
  if ((await readOnChain(c, escrowId)).status === "None") {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + config.ESCROW_DEADLINE_DAYS * 86400);
    sent = await send(c, "Create escrow (agreement e-signed)", c.operator, c.escrow, "createEscrow",
      [escrowKey(escrowId), searchKey(e.search_id), seller, toUnits(e.advance_deposit_amount_inr), toUnits(e.platform_escrow_fee_inr),
       bytes32OfSha256(e.agreement_sha256), keccak(propertyText(e)), deadline],
      { escrowId, searchId: e.search_id });
  }
  await q("UPDATE title_escrow_contracts SET chain_key = $2, chain_escrow_id = $3, seller_wallet = $4 WHERE escrow_id = $1", [escrowId, c.chainKey, escrowKey(escrowId), seller]);
  return sent;
}

/** Test-token faucet + gas for a wallet that will deposit into this escrow (demo wallet or MetaMask). */
export async function faucetFor(escrowId: string, address: string) {
  const c = await chainCtx();
  const e = await escrowRow(escrowId);
  if (!e) throw new ChainError("Escrow not found");
  if (!ethers.isAddress(address)) throw new ChainError("Not a valid wallet address");
  const meta = { escrowId, searchId: e.search_id };
  const need = toUnits(e.advance_deposit_amount_inr);
  const have: bigint = await c.token.balanceOf(address);
  const out: Array<string> = [];
  const gas = await ensureGas(c, address, meta);
  if (gas) out.push(gas);
  if (have < need) out.push((await send(c, "Faucet: mint test tokens (TST) for the buyer", c.operator, c.token, "faucetTo", [address, need - have], meta)).hash);
  return { address, tokens: fromUnits(await c.token.balanceOf(address)), txs: out };
}

/** Deposit from the buyer's demo wallet: faucet → approve → deposit (the buyer's key signs approve and deposit). */
export async function depositFromDemoWallet(escrowId: string) {
  await ensureOnChain(escrowId);
  const c = await chainCtx();
  const e = await escrowRow(escrowId);
  const buyer = partyWallet(c, escrowId, "buyer").connect(c.provider);
  const meta = { escrowId, searchId: e!.search_id };
  await faucetFor(escrowId, buyer.address);
  const amount = toUnits(e!.advance_deposit_amount_inr);
  await send(c, "Buyer approves the escrow to take the deposit", buyer, c.token, "approve", [await c.escrow.getAddress(), amount], meta);
  return send(c, "Buyer deposits the advance into TitleEscrow", buyer, c.escrow, "deposit", [escrowKey(escrowId)], meta);
}

/** The backend has started the title search: mark it on-chain. */
export async function beginVerificationOnChain(escrowId: string) {
  const c = await chainCtx();
  const e = await escrowRow(escrowId);
  if ((await readOnChain(c, escrowId)).status !== "Funded") return null;
  return send(c, "Verification started (title search running)", c.operator, c.escrow, "beginVerification", [escrowKey(escrowId)], { escrowId, searchId: e!.search_id });
}

/**
 * Verification policy → attestation. Signs only what the evidence supports:
 *   VERIFIED_CLEAN     only for a clean-title verdict (score ≥ 90, EC + RoR read, all web checks complete) or an advocate's approval
 *   QUALIFYING_DEFECT  only when a veto fired (active mortgage, court stay/injunction, prohibited land) or an advocate rejected it
 *   INCONCLUSIVE       everything else: the contract keeps the tokens locked
 */
export function decideOutcome(e: { verdict: string | null; assessment: any }, requested: "RELEASE_TO_SELLER" | "REFUND_TO_BUYER" | "DISPUTE_HOLD", advocate: "APPROVE" | "REJECT" | null): { outcome: Outcome; reason: string } {
  const rules: Array<{ kind: string; hit: boolean; label: string }> = e.assessment?.rules ?? [];
  const vetoes = rules.filter((r) => r.kind === "VETO" && r.hit);
  const guardrails = rules.filter((r) => r.kind === "GUARDRAIL" && r.hit);
  if (requested === "RELEASE_TO_SELLER") {
    if (advocate === "APPROVE") return { outcome: "VERIFIED_CLEAN", reason: "Advocate approved after review" };
    if (e.assessment?.verdict === "CLEAN_TITLE" && !vetoes.length && !guardrails.length) return { outcome: "VERIFIED_CLEAN", reason: "All configured checks passed" };
    return { outcome: "INCONCLUSIVE", reason: "Release requested but the evidence does not meet the clean-title policy" };
  }
  if (requested === "REFUND_TO_BUYER") {
    if (vetoes.length) return { outcome: "QUALIFYING_DEFECT", reason: vetoes.map((v) => v.label).join("; ") };
    if (advocate === "REJECT") return { outcome: "QUALIFYING_DEFECT", reason: "Advocate rejected the title after review" };
    return { outcome: "INCONCLUSIVE", reason: "No qualifying defect is established" };
  }
  return { outcome: "INCONCLUSIVE", reason: guardrails.map((g) => g.label).join("; ") || "Evidence incomplete or ambiguous" };
}

async function submit(c: ChainCtx, escrowId: string, searchId: string, signed: { verdict: Verdict; signature: string; signer: string }, label: string, kind: "VERDICT" | "SECURITY_TEST") {
  const row = await one<{ attestation_id: string }>(
    `INSERT INTO verification_attestations (escrow_id, search_id, kind, outcome, payload, signature, signer) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING attestation_id`,
    [escrowId, searchId, kind, signed.verdict.outcome, JSON.stringify(signed.verdict), signed.signature, signed.signer]);
  try {
    const tx = await send(c, label, c.operator, c.escrow, "settle", [verdictTuple(signed.verdict), signed.signature], { escrowId, searchId });
    await q("UPDATE verification_attestations SET status = 'ACCEPTED', tx_hash = $2 WHERE attestation_id = $1", [row!.attestation_id, tx.hash]);
    return tx;
  } catch (err) {
    await q("UPDATE verification_attestations SET status = 'REJECTED', error = $2 WHERE attestation_id = $1", [row!.attestation_id, (err as Error).message]);
    throw err;
  }
}

/** Signs the verdict with the oracle key and submits it; the contract enforces the result. */
export async function settleOnChain(escrowId: string, outcome: Outcome, x: { score: number; evidenceHash: string; advocateReviewed: boolean }) {
  const c = await chainCtx();
  const e = await escrowRow(escrowId);
  const st = (await readOnChain(c, escrowId)).status;
  if (st === "Released" || st === "Refunded") return null;
  if (outcome === "INCONCLUSIVE" && st === "Disputed") return null;
  const v = buildVerdict({ escrowId: escrowKey(escrowId), searchId: searchKey(e!.search_id), outcome, score: x.score, evidenceHash: bytes32OfSha256(x.evidenceHash), advocateReviewed: x.advocateReviewed });
  const signed = await signVerdict(c, v);
  const label = outcome === "VERIFIED_CLEAN" ? (x.advocateReviewed ? "Signed verdict: clean after advocate review → release to seller" : "Signed verdict: verified clean → release to seller")
    : outcome === "QUALIFYING_DEFECT" ? "Signed verdict: qualifying defect → refund buyer" : "Signed verdict: inconclusive → funds stay locked";
  return submit(c, escrowId, e!.search_id, signed, label, "VERDICT");
}

/** Shows the contract refusing attacks: a forged signer, a replayed verdict, an expired verdict, a verdict for another escrow. */
export async function securityCheck(escrowId: string, kind: "FORGED_SIGNER" | "REPLAY" | "EXPIRED" | "WRONG_ESCROW") {
  const c = await chainCtx();
  const e = await escrowRow(escrowId);
  if (!e) throw new ChainError("Escrow not found");
  const evidence = bytes32OfSha256(e.evidence_sha256_hash ?? crypto.createHash("sha256").update(canonicalJson(e.assessment ?? {})).digest("hex"));
  let signed: { verdict: Verdict; signature: string; signer: string };
  if (kind === "REPLAY") {
    const last = await one("SELECT payload, signature, signer FROM verification_attestations WHERE escrow_id = $1 AND status = 'ACCEPTED' ORDER BY created_at DESC LIMIT 1", [escrowId]);
    if (!last) throw new ChainError("No accepted verdict to replay yet");
    signed = { verdict: last.payload, signature: last.signature, signer: last.signer };
  } else {
    const base = buildVerdict({ escrowId: escrowKey(escrowId), searchId: searchKey(e.search_id), outcome: "VERIFIED_CLEAN", score: 100, evidenceHash: evidence,
      ...(kind === "EXPIRED" ? { now: Math.floor(Date.now() / 1000) - 3600, ttlSeconds: 60 } : {}) });
    if (kind === "WRONG_ESCROW") base.searchId = searchKey(crypto.randomUUID());
    signed = await signVerdict(c, base, kind === "FORGED_SIGNER" ? ethers.Wallet.createRandom() : c.oracle);
  }
  try {
    const tx = await submit(c, escrowId, e.search_id, signed, `Security check (${kind.toLowerCase().replace("_", " ")})`, "SECURITY_TEST");
    return { rejected: false, txHash: tx.hash, reason: "Accepted (unexpected)" };
  } catch (err) {
    return { rejected: true, reason: (err as Error).message, signer: signed.signer, recovered: await recoverSigner(c, signed.verdict, signed.signature).catch(() => null) };
  }
}

/** Live on-chain view of one escrow for the escrow page. */
export async function escrowOnChain(escrowId: string) {
  if (!chainEnabled()) return { enabled: false };
  try {
    const c = await chainCtx();
    const e = await escrowRow(escrowId);
    if (!e) return { enabled: true, onChain: false };
    const id = escrowKey(escrowId);
    const s = await c.escrow.escrows(id);
    const status = STATUS[Number(s.status)];
    const bal = async (a: string | null) => (a && a !== ethers.ZeroAddress ? fromUnits(await c.token.balanceOf(a)) : 0);
    const demoBuyer = partyWallet(c, escrowId, "buyer").address;
    const attestations = await q("SELECT kind, outcome, payload, signature, signer, status, tx_hash, error, created_at FROM verification_attestations WHERE escrow_id = $1 ORDER BY created_at", [escrowId]);
    return {
      enabled: true,
      onChain: status !== "None",
      network: { chainId: c.chainId, mode: config.CHAIN_MODE, explorer: config.CHAIN_EXPLORER_URL || null },
      escrowKey: id, searchKey: s.searchId,
      contract: await c.escrow.getAddress(), token: await c.token.getAddress(),
      status,
      amount: fromUnits(s.amount), fee: fromUnits(s.fee), score: Number(s.score),
      deadline: Number(s.deadline) ? new Date(Number(s.deadline) * 1000).toISOString() : null,
      agreementHash: s.agreementHash, propertyHash: s.propertyHash, evidenceHash: s.evidenceHash,
      demoBuyerWallet: demoBuyer,
      wallets: {
        buyer: { address: s.buyer !== ethers.ZeroAddress ? s.buyer : null, tokens: await bal(s.buyer) },
        seller: { address: s.seller, tokens: await bal(s.seller) },
        escrowContract: { address: await c.escrow.getAddress(), tokens: await bal(await c.escrow.getAddress()) },
        oracle: { address: c.oracle.address }, operator: { address: c.operator.address }
      },
      attestations,
      transactions: await chainTxs({ escrowId })
    };
  } catch (err) {
    return { enabled: true, onChain: false, error: (err as Error).message };
  }
}

export { explain };
