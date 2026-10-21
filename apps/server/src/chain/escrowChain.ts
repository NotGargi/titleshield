import { config } from "../config.ts";
import { one, q } from "../db/pool.ts";
import { STATES } from "@titleshield/core";
import { ChainError, STATUS, bytes32OfSha256, chainCtx, chainEnabled, chainTxs, escrowKey, fromPaise, keccak, partyWallet, send, toPaise, type SentTx } from "./chain.ts";

/**
 * TitleEscrow smart contract ↔ escrow state machine.
 *   both parties e-sign      → open()     escrow registered on chain with the buyer/seller wallets and the agreement hash
 *   bank credits the advance → fund()     the trustee tokenises the advance; tINR locked in the contract
 *   verdict CLEAR            → release()  tINR to the seller's wallet (fee to the fee wallet)
 *   verdict DEFECT           → refund()   full advance back to the buyer's wallet
 *   verdict CONDITIONAL      → hold()     stays locked until the advocate's decision
 *   bank pays out in rupees  → redeem()   the paid-out tINR is retired (off-ramp)
 */

async function escrowRow(escrowId: string) {
  return one(`SELECT e.*, s.state_code, s.district_name, s.village_name, s.survey_number, s.address_text
              FROM title_escrow_contracts e JOIN title_searches s USING (search_id) WHERE e.escrow_id = $1`, [escrowId]);
}

const propertyText = (e: any) => [e.address_text, e.survey_number && `Survey ${e.survey_number}`, e.village_name, e.district_name, STATES[e.state_code]?.name].filter(Boolean).join(", ");

/** Registers the escrow on chain if it isn't yet (idempotent; also re-registers after a local chain reset). */
export async function ensureOnChain(escrowId: string): Promise<SentTx | null> {
  if (!chainEnabled()) return null;
  const c = await chainCtx();
  const e = await escrowRow(escrowId);
  if (!e) throw new ChainError("Escrow not found");
  const id = escrowKey(escrowId);
  const onChain = await c.escrow.escrows(id);
  const buyer = partyWallet(c, escrowId, "buyer"), seller = partyWallet(c, escrowId, "seller");
  let sent: SentTx | null = null;
  if (Number(onChain.status) === 0) {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + config.ESCROW_DEADLINE_DAYS * 86400);
    sent = await send(c, "Open escrow (agreement e-signed)", c.trustee, c.escrow, "open",
      [id, buyer, seller, toPaise(e.advance_deposit_amount_inr), toPaise(e.platform_escrow_fee_inr), bytes32OfSha256(e.agreement_sha256), keccak(propertyText(e)), deadline],
      { escrowId, searchId: e.search_id });
  }
  await q("UPDATE title_escrow_contracts SET chain_key = $2, chain_escrow_id = $3, buyer_wallet = $4, seller_wallet = $5 WHERE escrow_id = $1", [escrowId, c.chainKey, id, buyer, seller]);
  return sent;
}

/** The advance reached the trustee bank: lock the same amount of tINR in the contract. */
export async function chainFund(escrowId: string, bankUtr: string) {
  if (!chainEnabled()) return null;
  await ensureOnChain(escrowId);
  const c = await chainCtx();
  const e = await escrowRow(escrowId);
  const s = await c.escrow.escrows(escrowKey(escrowId));
  if (Number(s.status) !== 1) return null; // already funded
  return send(c, "Lock advance in TitleEscrow (tokenised from bank deposit)", c.trustee, c.escrow, "fund", [escrowKey(escrowId), keccak(`UTR:${bankUtr}`)], { escrowId, searchId: e!.search_id });
}

/** Is this escrow on the current chain? (Escrows made before the contract existed, or before a chain reset, are not.) */
async function linked(escrowId: string) {
  if (!chainEnabled()) return null;
  const c = await chainCtx();
  const e = await escrowRow(escrowId);
  if (!e?.chain_escrow_id || e.chain_key !== c.chainKey) return null;
  const s = await c.escrow.escrows(escrowKey(escrowId));
  if (Number(s.status) === 0) return null;
  return { c, e, status: STATUS[Number(s.status)] };
}

export async function chainSettle(escrowId: string, action: "RELEASE_TO_SELLER" | "REFUND_TO_BUYER" | "DISPUTE_HOLD", x: { score: number; evidenceHash: string; reason: string; advocateApproval: string | null }) {
  const l = await linked(escrowId);
  if (!l) return null;
  const { c, e, status } = l;
  const id = escrowKey(escrowId), cert = bytes32OfSha256(x.evidenceHash), score = Math.max(0, Math.min(100, Math.round(x.score)));
  const meta = { escrowId, searchId: e.search_id };
  if (action === "DISPUTE_HOLD") {
    if (status !== "Funded") return null;
    return send(c, "Hold for advocate review (title uncertain)", c.oracle, c.escrow, "hold", [id, score, cert], meta);
  }
  if (status === "Released" || status === "Refunded") return null;
  if (action === "RELEASE_TO_SELLER") {
    return send(c, x.advocateApproval ? "Release to seller (advocate approved)" : "Release to seller (clean title certificate)", c.oracle, c.escrow, "release",
      [id, score, cert, x.advocateApproval ? keccak(x.advocateApproval) : "0x" + "00".repeat(32)], meta);
  }
  return send(c, "Refund buyer (title defect found)", c.oracle, c.escrow, "refund", [id, score, cert, x.reason.slice(0, 200)], meta);
}

/** The bank paid rupees out of the escrow account: retire the matching tINR (off-ramp). */
export async function chainRedeem(escrowId: string, beneficiary: "PAYEE_A" | "PAYEE_B" | "PLATFORM_FEE", amountINR: number, utr: string) {
  const l = await linked(escrowId);
  if (!l) return null;
  const { c, e } = l;
  const holder = beneficiary === "PAYEE_A" ? e.seller_wallet : beneficiary === "PAYEE_B" ? e.buyer_wallet : c.feeWallet;
  const label = beneficiary === "PAYEE_A" ? "Redeem seller's tINR — paid to seller's bank account" : beneficiary === "PAYEE_B" ? "Redeem buyer's tINR — refunded to buyer's bank account" : "Redeem escrow fee tINR";
  return send(c, label, c.trustee, c.token, "redeem", [holder.trim(), toPaise(amountINR), keccak(`UTR:${utr}`)], { escrowId, searchId: e.search_id });
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
    const bal = async (a: string | null) => (a ? fromPaise(await c.token.balanceOf(a)) : 0);
    const buyer = e.buyer_wallet?.trim() || partyWallet(c, escrowId, "buyer"), seller = e.seller_wallet?.trim() || partyWallet(c, escrowId, "seller");
    return {
      enabled: true,
      onChain: status !== "None",
      escrowKey: id,
      contract: await c.escrow.getAddress(),
      token: await c.token.getAddress(),
      chainId: c.chainId,
      status,
      amountINR: fromPaise(s.amount), feeINR: fromPaise(s.fee),
      score: Number(s.score),
      deadline: Number(s.deadline) ? new Date(Number(s.deadline) * 1000).toISOString() : null,
      agreementHash: s.agreementHash, propertyHash: s.propertyHash, depositReference: s.depositReference, certificateHash: s.certificateHash,
      wallets: {
        buyer: { address: buyer, tINR: await bal(buyer) },
        seller: { address: seller, tINR: await bal(seller) },
        escrowContract: { address: await c.escrow.getAddress(), tINR: await bal(await c.escrow.getAddress()) },
        oracle: { address: c.oracle.address }, trustee: { address: c.trustee.address }
      },
      transactions: await chainTxs({ escrowId })
    };
  } catch (err) {
    return { enabled: true, onChain: false, error: (err as Error).message };
  }
}
