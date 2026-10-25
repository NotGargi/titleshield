import crypto from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { STATES, canonicalJson, compareNames } from "@titleshield/core";
import { config } from "../config.ts";
import { one, q, tx } from "../db/pool.ts";
import { encryptField, maskAccount, sha256, hmacSha256, safeEqualHex } from "../crypto/secrets.ts";
import { putImmutable } from "../storage/worm.ts";
import { pdfSafe } from "../certs/tcc.ts";
import { publish } from "../events/bus.ts";
import { resolveLocation } from "../geo/geocode.ts";
import * as bank from "./sandboxBank.ts";
import { oraclePublicKeyPem, signInstruction } from "./oracle.ts";
import { beginVerificationOnChain, decideOutcome, depositFromDemoWallet, ensureOnChain, readOnChain, settleOnChain } from "../chain/escrowChain.ts";
import { chainCtx, chainEnabled } from "../chain/chain.ts";

/** Programmable title escrow (PDF §6): state machine, tri-party eSign, deposits, settlement. */

export type EscrowState = "AWAITING_DEPOSIT" | "FUNDS_LOCKED" | "VERIFICATION_IN_PROGRESS" | "RELEASED_TO_SELLER" | "REFUNDED_TO_BUYER" | "DISPUTE_HOLD";

const TRANSITIONS: Record<EscrowState, EscrowState[]> = {
  AWAITING_DEPOSIT: ["FUNDS_LOCKED"],
  FUNDS_LOCKED: ["VERIFICATION_IN_PROGRESS"],
  VERIFICATION_IN_PROGRESS: ["RELEASED_TO_SELLER", "REFUNDED_TO_BUYER", "DISPUTE_HOLD"],
  DISPUTE_HOLD: ["RELEASED_TO_SELLER", "REFUNDED_TO_BUYER"],
  RELEASED_TO_SELLER: [],
  REFUNDED_TO_BUYER: []
};

export class EscrowError extends Error { constructor(public statusCode: number, msg: string) { super(msg); } }

export async function transition(escrowId: string, to: EscrowState, actor: string, detail: object = {}) {
  return tx(async (c) => {
    const r = await c.query("SELECT escrow_state, search_id FROM title_escrow_contracts WHERE escrow_id = $1 FOR UPDATE", [escrowId]);
    if (!r.rows[0]) throw new EscrowError(404, "Escrow not found");
    const from = r.rows[0].escrow_state as EscrowState;
    if (from === to) return { from, to, changed: false };
    if (!TRANSITIONS[from].includes(to)) throw new EscrowError(409, `Escrow cannot move from ${from} to ${to}`);
    await c.query(`UPDATE title_escrow_contracts SET escrow_state = $2::varchar, settled_at = CASE WHEN $2::varchar IN ('RELEASED_TO_SELLER','REFUNDED_TO_BUYER') THEN NOW() ELSE settled_at END WHERE escrow_id = $1`, [escrowId, to]);
    await c.query("INSERT INTO escrow_events (escrow_id, from_state, to_state, actor, detail) VALUES ($1,$2,$3,$4,$5)", [escrowId, from, to, actor, JSON.stringify(detail)]);
    if (r.rows[0].search_id) await publish(r.rows[0].search_id, "escrow_state", { escrowId, from, to, actor, ...detail });
    return { from, to, changed: true };
  });
}

export interface CreateEscrowInput {
  property: {
    stateCode?: string | null; district?: string | null; taluk?: string | null; hobli?: string | null; village?: string | null; surveyNumber?: string | null;
    subDivisionHissa?: string | null; addressText?: string | null; locality?: string | null; pincode?: string | null; latitude?: number | null; longitude?: number | null;
  };
  buyer: { name: string; accountNumber: string; ifsc: string };
  seller: { name: string; accountNumber: string; ifsc: string };
  /** Optional seller wallet for the smart-contract release (a demo wallet is created otherwise). */
  sellerWallet?: string | null;
  propertyValueINR: number;
  advancePercent?: number;
  consentAccepted: boolean;
}

export const CONSENT_NOTICE = `I consent to TitleShield (BhoomiTrust) processing my name, bank account and the property's public land, registration, court and mortgage records to verify title and operate the escrow described in this agreement, as permitted by the Digital Personal Data Protection Act, 2023. My data is stored in India, used only for this purpose and retained for the legally required period. I may withdraw consent for future processing at any time.`;

async function agreementPdf(e: { escrowRef: string; property: CreateEscrowInput["property"]; buyer: string; seller: string; value: number; advance: number; fee: number; va: string; ifsc: string }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const f = await doc.embedFont(StandardFonts.Helvetica), b = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const line = (t: string, o: { bold?: boolean; size?: number } = {}) => {
    const size = o.size ?? 10;
    const words = pdfSafe(t).split(" ");
    let cur = "";
    for (const w of words) {
      const n = cur ? `${cur} ${w}` : w;
      if ((o.bold ? b : f).widthOfTextAtSize(n, size) > 500 && cur) { page.drawText(cur, { x: 48, y, size, font: o.bold ? b : f, color: rgb(0.1, 0.1, 0.1) }); y -= size + 4; cur = w; } else cur = n;
    }
    if (cur) { page.drawText(cur, { x: 48, y, size, font: o.bold ? b : f, color: rgb(0.1, 0.1, 0.1) }); y -= size + 4; }
    y -= 3;
  };
  const st = STATES[e.property.stateCode ?? ""]?.name ?? e.property.stateCode ?? "";
  line("TRI-PARTY TITLE ESCROW AGREEMENT", { bold: true, size: 15 });
  line(`Escrow reference ${e.escrowRef} - generated ${new Date().toISOString().slice(0, 10)}`, { size: 9 });
  line(`Parties: (1) ${e.buyer} ("Buyer"); (2) ${e.seller} ("Seller"); (3) TitleShield (BhoomiTrust) as verification agent, with the trustee bank as escrow agent.`);
  line(`Property: ${e.property.addressText ? `${e.property.addressText}. ` : ""}${e.property.surveyNumber ? `Survey ${e.property.surveyNumber}${e.property.subDivisionHissa ? "/" + e.property.subDivisionHissa : ""}, ` : ""}${[e.property.village ?? e.property.locality, e.property.taluk, e.property.district].filter(Boolean).join(", ")}, ${st}.`);
  line(`Agreed sale consideration: Rs. ${e.value.toLocaleString("en-IN")}. Advance to be held in escrow: Rs. ${e.advance.toLocaleString("en-IN")}.`);
  if (chainEnabled()) line("Escrow: the advance is deposited as test tokens (TST, no monetary value) into the TitleEscrow smart contract, which can release them only to the Seller's wallet or refund them to the Buyer's wallet.");
  else line(`Escrow account: ${e.va} (IFSC ${e.ifsc}). Funds may move only to the Seller's verified account or back to the Buyer's source account.`);
  line("1. On receipt of the advance, TitleShield runs a 30-year title search of the land revenue record, Encumbrance Certificate, eCourts and CERSAI.", { size: 9.5 });
  line("2. Clean title (score >= 90, no active mortgage, no pending litigation): the advance less the escrow fee is released to the Seller and the property is monitored daily until the sale deed is registered.", { size: 9.5 });
  line("3. Defect (active mortgage, live stay/injunction, prohibited land category, or score < 50): the full advance is refunded to the Buyer and a defect evidence report is issued.", { size: 9.5 });
  line("4. Any other result is held for an empanelled advocate's review, whose decision triggers release or refund.", { size: 9.5 });
  line(`5. Escrow fee: ${config.PLATFORM_FEE_BPS / 100}% of the advance (Rs. ${e.fee.toLocaleString("en-IN")}), charged only on release. Refunds are made in full.`, { size: 9.5 });
  line(chainEnabled()
    ? "6. Release, refund or hold is decided by a verdict signed by the TitleShield verification oracle (EIP-712, bound to this escrow, the title search and the evidence hash, with an expiry and a one-time nonce). The smart contract verifies the signature and enforces the result; an inconclusive verdict keeps the deposit locked."
    : "6. Release and refund instructions are digitally signed by the TitleShield verification oracle; the bank verifies the signature before executing any payment.", { size: 9.5 });
  line("7. This agreement is executed electronically by Aadhaar eSign under the Information Technology Act, 2000 and is governed by the Indian Contract Act, 1872.", { size: 9.5 });
  return Buffer.from(await doc.save());
}

export async function createEscrow(input: CreateEscrowInput, createdBy: string | null) {
  if (!input.consentAccepted) throw new EscrowError(400, "Consent is required to create an escrow");
  const p = input.property;
  if (!p.stateCode || !p.district || !(p.village || p.locality)) {
    const loc = await resolveLocation({ addressText: p.addressText, stateCode: p.stateCode, district: p.district, taluk: p.taluk, village: p.village, locality: p.locality, pincode: p.pincode, lat: p.latitude, lon: p.longitude });
    p.stateCode = p.stateCode || loc.stateCode; p.district = p.district || loc.district; p.taluk = p.taluk || loc.taluk;
    p.village = p.village || loc.village; p.locality = p.locality || loc.locality; p.pincode = p.pincode || loc.pincode;
    p.latitude = p.latitude ?? loc.lat; p.longitude = p.longitude ?? loc.lon;
  }
  if (!p.stateCode || !STATES[p.stateCode]) throw new EscrowError(400, "Couldn't work out the state from this address. Choose the state.");
  if (!p.district || !(p.village || p.locality)) throw new EscrowError(400, "Enter the district and the village or locality.");
  const pct = input.advancePercent ?? 10;
  const advance = Math.round(input.propertyValueINR * pct) / 100;
  const fee = Math.round(advance * config.PLATFORM_FEE_BPS) / 10000;

  // Penny-drop both accounts and check the names (PDF §6.3: payees are verified before whitelisting).
  const sellerPd = await bank.pennyDrop(input.seller.accountNumber, input.seller.ifsc, input.seller.name).catch((e) => { throw new EscrowError(400, `Seller account: ${e.message}`); });
  const buyerPd = await bank.pennyDrop(input.buyer.accountNumber, input.buyer.ifsc, input.buyer.name).catch((e) => { throw new EscrowError(400, `Buyer account: ${e.message}`); });
  const sellerMatch = compareNames(input.seller.name, sellerPd.nameAtBank);
  if (sellerMatch.kind === "mismatch") throw new EscrowError(422, `Seller's bank account is registered to "${sellerPd.nameAtBank}", not ${input.seller.name}`);
  if (compareNames(input.buyer.name, buyerPd.nameAtBank).kind === "mismatch") throw new EscrowError(422, `Buyer's bank account is registered to "${buyerPd.nameAtBank}"`);

  const escrowRef = `TSE-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomInt(100000, 999999)}`;
  const search = await one(`INSERT INTO title_searches (tenant_id, tier_type, state_code, district_name, taluk_name, hobli_name, village_name, survey_number, sub_division_hissa,
       claimed_owner_name, created_by, client_reference, address_text, locality, pincode, latitude, longitude, portal_mode)
     VALUES ((SELECT tenant_id FROM tenants WHERE name = 'TitleShield Retail'), 'ESCROW_LINKED', $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'live') RETURNING search_id`,
    [p.stateCode, p.district, p.taluk ?? "", p.hobli ?? null, p.village || p.locality, p.surveyNumber ?? "", p.subDivisionHissa ?? null, input.seller.name, createdBy, escrowRef,
     p.addressText ?? null, p.locality ?? null, p.pincode ?? null, p.latitude ?? null, p.longitude ?? null]);

  const payee = (p: CreateEscrowInput["buyer"]): bank.Payee => ({ holderName: p.name, accountMask: maskAccount(p.accountNumber), ifsc: p.ifsc.toUpperCase(), accountToken: encryptField(p.accountNumber) });
  const va = await bank.openVirtualAccount({
    escrowReference: escrowRef, expectedAmountINR: advance,
    payeeA: payee(input.seller), payeeB: payee(input.buyer),
    feeAccount: { holderName: "TitleShield Technologies Pvt Ltd", accountMask: "XXXX0425", ifsc: "YESB0000425", accountToken: "platform-fee-account" },
    oraclePublicKeyPem: oraclePublicKeyPem(),
    webhookUrl: `${config.PUBLIC_BASE_URL}/api/v1/webhooks/bank`
  });

  const pdf = await agreementPdf({ escrowRef, property: input.property, buyer: input.buyer.name, seller: input.seller.name, value: input.propertyValueINR, advance, fee, va: va.vaNumber, ifsc: va.ifsc });
  const stored = await putImmutable(`escrows/${escrowRef}/tri-party-agreement.pdf`, pdf, "application/pdf");

  const row = await one(`INSERT INTO title_escrow_contracts (search_id, buyer_user_id, buyer_refund_account_no, buyer_refund_ifsc, seller_user_id, seller_payout_account_no, seller_payout_ifsc,
      property_total_value_inr, advance_deposit_amount_inr, platform_escrow_fee_inr, partner_bank_escrow_id, virtual_account_number, virtual_account_ifsc,
      tri_party_esign_doc_uri, buyer_name, seller_name, buyer_account_mask, seller_account_mask, seller_penny_drop_name, seller_penny_drop_match, agreement_sha256, created_by)
    VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, gen_random_uuid(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING escrow_id`,
    [search!.search_id, createdBy, encryptField(input.buyer.accountNumber), input.buyer.ifsc.toUpperCase(), encryptField(input.seller.accountNumber), input.seller.ifsc.toUpperCase(),
     input.propertyValueINR, advance, fee, va.bankEscrowId, va.vaNumber, va.ifsc, stored.uri, input.buyer.name, input.seller.name,
     maskAccount(input.buyer.accountNumber), maskAccount(input.seller.accountNumber), sellerPd.nameAtBank, sellerMatch.kind, stored.sha256, createdBy]);

  for (const who of [input.buyer.name, input.seller.name]) {
    await q("INSERT INTO consent_artifacts (principal_name, principal_user_id, purpose, notice_text, notice_sha256, search_id, escrow_id) VALUES ($1,$2,'TITLE_ESCROW',$3,$4,$5,$6)",
      [who, who === input.buyer.name ? createdBy : null, CONSENT_NOTICE, sha256(CONSENT_NOTICE), search!.search_id, row!.escrow_id]);
  }
  if (input.sellerWallet) await q("UPDATE title_escrow_contracts SET seller_wallet = $2 WHERE escrow_id = $1", [row!.escrow_id, input.sellerWallet]);
  await q("INSERT INTO escrow_events (escrow_id, from_state, to_state, actor, detail) VALUES ($1, NULL, 'AWAITING_DEPOSIT', 'system', $2)", [row!.escrow_id, JSON.stringify({ escrowRef, virtualAccount: va.vaNumber })]);
  return getEscrow(row!.escrow_id);
}

export async function getEscrow(escrowId: string) {
  const e = await one(`SELECT e.escrow_id, e.search_id, e.escrow_state, e.property_total_value_inr, e.advance_deposit_amount_inr, e.platform_escrow_fee_inr,
      e.amount_deposited_inr, e.settlement_amount_inr, e.partner_bank_escrow_id, e.virtual_account_number, e.virtual_account_ifsc, e.buyer_name, e.seller_name,
      e.buyer_account_mask, e.seller_account_mask, e.buyer_refund_ifsc, e.seller_payout_ifsc, e.seller_penny_drop_name, e.seller_penny_drop_match,
      e.bank_utr_deposit, e.bank_utr_settlement, e.agreement_sha256, e.funding_rail, e.buyer_wallet, e.seller_wallet, e.settlement_instruction, e.buyer_signed_at, e.seller_signed_at, e.created_at, e.settled_at, e.created_by,
      s.state_code, s.district_name, s.taluk_name, s.village_name, s.survey_number, s.address_text, s.latitude, s.longitude, s.status AS search_status, s.client_reference AS escrow_reference
    FROM title_escrow_contracts e JOIN title_searches s USING (search_id) WHERE e.escrow_id = $1`, [escrowId]);
  if (!e) return null;
  const events = await q("SELECT from_state, to_state, actor, detail, created_at FROM escrow_events WHERE escrow_id = $1 ORDER BY id", [escrowId]);
  return { ...e, events };
}

// ---------- Aadhaar eSign (sandbox ESP) ----------

export async function startESign(escrowId: string, party: "BUYER" | "SELLER", aadhaarLast4: string) {
  if (!/^\d{4}$/.test(aadhaarLast4)) throw new EscrowError(400, "Enter the last 4 digits of the Aadhaar number");
  const e = await one("SELECT buyer_name, seller_name, buyer_signed_at, seller_signed_at FROM title_escrow_contracts WHERE escrow_id = $1", [escrowId]);
  if (!e) throw new EscrowError(404, "Escrow not found");
  if ((party === "BUYER" ? e.buyer_signed_at : e.seller_signed_at)) throw new EscrowError(409, `${party.toLowerCase()} has already signed`);
  const otp = String(crypto.randomInt(100000, 999999));
  const s = await one(`INSERT INTO esign_sessions (escrow_id, party, signer_name, aadhaar_last4, otp_hash, expires_at) VALUES ($1,$2,$3,$4,$5, NOW() + interval '10 minutes') RETURNING esign_id`,
    [escrowId, party, party === "BUYER" ? e.buyer_name : e.seller_name, aadhaarLast4, sha256(`${escrowId}:${otp}`)]);
  // A licensed ESP sends this OTP from UIDAI to the Aadhaar-linked mobile. The sandbox returns it so the flow can be completed.
  return { esignId: s!.esign_id, maskedAadhaar: `XXXX XXXX ${aadhaarLast4}`, sandboxOtp: config.ESIGN_PROVIDER === "sandbox" ? otp : undefined, expiresInSeconds: 600 };
}

export async function completeESign(escrowId: string, esignId: string, otp: string) {
  const signed = await signWithOtp(escrowId, esignId, otp);
  const e = await one("SELECT buyer_signed_at, seller_signed_at FROM title_escrow_contracts WHERE escrow_id = $1", [escrowId]);
  if (e?.buyer_signed_at && e?.seller_signed_at) {
    // Both parties have signed: register the escrow in the TitleEscrow smart contract.
    // If the chain is briefly unavailable this is retried when the advance arrives.
    await ensureOnChain(escrowId).catch((err) => console.error("chain: open escrow failed:", (err as Error).message));
  }
  return signed;
}

async function signWithOtp(escrowId: string, esignId: string, otp: string) {
  return tx(async (c) => {
    const r = await c.query("SELECT * FROM esign_sessions WHERE esign_id = $1 AND escrow_id = $2 FOR UPDATE", [esignId, escrowId]);
    const s = r.rows[0];
    if (!s) throw new EscrowError(404, "eSign session not found");
    if (s.status !== "OTP_SENT") throw new EscrowError(409, `eSign session is ${s.status}`);
    if (new Date(s.expires_at) < new Date()) { await c.query("UPDATE esign_sessions SET status = 'EXPIRED' WHERE esign_id = $1", [esignId]); throw new EscrowError(410, "OTP expired. Start again."); }
    if (!safeEqualHex(sha256(`${escrowId}:${otp}`), s.otp_hash)) {
      await c.query("UPDATE esign_sessions SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= 3 THEN 'FAILED' ELSE status END WHERE esign_id = $1", [esignId]);
      throw new EscrowError(401, "Incorrect OTP");
    }
    const e = (await c.query("SELECT agreement_sha256 FROM title_escrow_contracts WHERE escrow_id = $1", [escrowId])).rows[0];
    const now = new Date().toISOString();
    const sigHash = sha256(`${e.agreement_sha256}|${s.party}|${s.signer_name}|${s.aadhaar_last4}|${now}`);
    await c.query("UPDATE esign_sessions SET status = 'SIGNED', signed_at = $2, signature_sha256 = $3 WHERE esign_id = $1", [esignId, now, sigHash]);
    await c.query(`UPDATE title_escrow_contracts SET ${s.party === "BUYER" ? "buyer_signed_at" : "seller_signed_at"} = $2 WHERE escrow_id = $1`, [escrowId, now]);
    await c.query("INSERT INTO escrow_events (escrow_id, from_state, to_state, actor, detail) SELECT escrow_id, escrow_state, escrow_state, $2, $3 FROM title_escrow_contracts WHERE escrow_id = $1",
      [escrowId, `esign:${s.party.toLowerCase()}`, JSON.stringify({ signed: s.party, signatureSha256: sigHash })]);
    return { party: s.party, signedAt: now, signatureSha256: sigHash };
  });
}

// ---------- Deposits (bank → TitleShield webhook) ----------

export function verifyBankSignature(rawBody: string, signature: string | undefined) {
  return !!signature && safeEqualHex(hmacSha256(config.BANK_WEBHOOK_SECRET, rawBody), signature);
}

/** Returns the searchId to start when the advance is fully funded. */
export async function onBankWebhook(evt: any): Promise<{ startSearchId?: string }> {
  const e = await one("SELECT escrow_id, search_id, escrow_state, advance_deposit_amount_inr, amount_deposited_inr, buyer_signed_at, seller_signed_at FROM title_escrow_contracts WHERE partner_bank_escrow_id = $1", [`SBX-${evt.escrowReference}`]);
  if (!e) return {};
  const fresh = await one("INSERT INTO bank_webhook_events (utr, event, escrow_id, amount_inr) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING utr",
    [evt.utr, evt.event, e.escrow_id, evt.amountINR ?? null]);
  if (!fresh) return {};                                   // duplicate delivery
  try {
    return await processBankEvent(e, evt);
  } catch (err) {
    // Let the bank's retry be processed again.
    await q("DELETE FROM bank_webhook_events WHERE utr = $1", [evt.utr]);
    throw err;
  }
}

async function processBankEvent(e: any, evt: any): Promise<{ startSearchId?: string }> {
  if (evt.event === "VA_CREDIT") {
    // Total is derived from the de-duplicated credit events, so retries can never double-count.
    const sum = await one("SELECT COALESCE(SUM(amount_inr), 0) AS total FROM bank_webhook_events WHERE escrow_id = $1 AND event = 'VA_CREDIT'", [e.escrow_id]);
    const total = Number(sum!.total);
    await q("UPDATE title_escrow_contracts SET amount_deposited_inr = $2, bank_utr_deposit = COALESCE(bank_utr_deposit, $3) WHERE escrow_id = $1", [e.escrow_id, total, evt.utr]);
    await publish(e.search_id, "escrow_deposit", { utr: evt.utr, amountINR: evt.amountINR, mode: evt.mode, totalDepositedINR: total, requiredINR: Number(e.advance_deposit_amount_inr) });
    if (e.escrow_state === "AWAITING_DEPOSIT" && total + 0.001 >= Number(e.advance_deposit_amount_inr)) {
      await q("UPDATE title_escrow_contracts SET funding_rail = 'BANK' WHERE escrow_id = $1", [e.escrow_id]);
      await transition(e.escrow_id, "FUNDS_LOCKED", "bank:webhook", { utr: evt.utr, amountINR: total });
      await transition(e.escrow_id, "VERIFICATION_IN_PROGRESS", "system", { reason: "Advance fully funded; title search started" });
      return { startSearchId: e.search_id };
    }
  }
  if (evt.event === "PAYOUT_SUCCESS") {
    await q("UPDATE title_escrow_contracts SET bank_utr_settlement = COALESCE(bank_utr_settlement, $2) WHERE escrow_id = $1", [e.escrow_id, evt.utr]);
    await publish(e.search_id, "escrow_payout_confirmed", { utr: evt.utr, beneficiary: evt.beneficiary, amountINR: evt.amountINR, mode: evt.mode });
  }
  return {};
}

export async function simulateDeposit(escrowId: string, mode: "UPI" | "NEFT" | "RTGS" | "IMPS", amountINR?: number) {
  const e = await one("SELECT * FROM title_escrow_contracts WHERE escrow_id = $1", [escrowId]);
  if (!e) throw new EscrowError(404, "Escrow not found");
  if (chainEnabled()) throw new EscrowError(409, "This escrow is held by the TitleEscrow smart contract: the buyer deposits test tokens instead of paying the bank.");
  if (!e.buyer_signed_at || !e.seller_signed_at) throw new EscrowError(409, "Both buyer and seller must eSign the agreement before the advance is paid");
  if (e.escrow_state !== "AWAITING_DEPOSIT") throw new EscrowError(409, `Escrow is ${e.escrow_state}`);
  const amount = amountINR ?? Number(e.advance_deposit_amount_inr) - Number(e.amount_deposited_inr);
  try {
    return await bank.receiveCredit({ vaNumber: e.virtual_account_number, amountINR: amount, mode, payerName: e.buyer_name, payerAccountMask: e.buyer_account_mask });
  } catch (err) {
    if (err instanceof bank.BankError) throw new EscrowError(422, err.message);
    throw err;
  }
}

// ---------- On-chain deposit (TitleEscrow smart contract) ----------

/** Buyer deposits test tokens from the demo wallet (faucet → approve → deposit). */
export async function depositOnChain(escrowId: string) {
  const e = await one("SELECT * FROM title_escrow_contracts WHERE escrow_id = $1", [escrowId]);
  if (!e) throw new EscrowError(404, "Escrow not found");
  if (!e.buyer_signed_at || !e.seller_signed_at) throw new EscrowError(409, "Both buyer and seller must eSign the agreement before the deposit");
  if (e.escrow_state !== "AWAITING_DEPOSIT") throw new EscrowError(409, `Escrow is ${e.escrow_state}`);
  try { await depositFromDemoWallet(escrowId); } catch (err) { throw new EscrowError(422, (err as Error).message); }
  return onChainFunded(escrowId);
}

/**
 * The contract holds the deposit (checked on-chain, never taken from the browser's word):
 * lock the escrow, mark verification started on-chain, and return the search to start.
 */
export async function onChainFunded(escrowId: string): Promise<{ startSearchId?: string; buyer?: string; amount?: number }> {
  const e = await one("SELECT * FROM title_escrow_contracts WHERE escrow_id = $1", [escrowId]);
  if (!e) throw new EscrowError(404, "Escrow not found");
  const c = await chainCtx();
  const oc = await readOnChain(c, escrowId);
  if (oc.status === "None" || oc.status === "Created") throw new EscrowError(409, "The TitleEscrow contract has not received the deposit yet");
  if (e.escrow_state !== "AWAITING_DEPOSIT") return {};
  const t = await transition(escrowId, "FUNDS_LOCKED", "contract:deposit", { buyerWallet: oc.buyer, amount: oc.amount, asset: "TST (test token)" });
  if (!t.changed) return {};
  await q("UPDATE title_escrow_contracts SET amount_deposited_inr = $2, buyer_wallet = $3, funding_rail = 'CHAIN' WHERE escrow_id = $1", [escrowId, oc.amount, oc.buyer]);
  await publish(e.search_id, "escrow_deposit", { mode: "ON-CHAIN", amountINR: oc.amount, totalDepositedINR: oc.amount, requiredINR: Number(e.advance_deposit_amount_inr), buyerWallet: oc.buyer, utr: null });
  await transition(escrowId, "VERIFICATION_IN_PROGRESS", "system", { reason: "Deposit locked in the contract; title search started" });
  await beginVerificationOnChain(escrowId);
  return { startSearchId: e.search_id, buyer: oc.buyer, amount: oc.amount };
}

// ---------- Settlement (oracle-signed) ----------

export async function settle(searchId: string, action: "RELEASE_TO_SELLER" | "REFUND_TO_BUYER" | "DISPUTE_HOLD", ctx: { certificateId: string; evidenceHash: string; verdict: string; actor: string }) {
  const e = await one("SELECT * FROM title_escrow_contracts WHERE search_id = $1", [searchId]);
  if (!e) return null;
  if (["RELEASED_TO_SELLER", "REFUNDED_TO_BUYER"].includes(e.escrow_state)) return { alreadySettled: e.escrow_state };

  // Smart-contract escrow: the oracle signs a verdict the evidence supports; the contract enforces it.
  if (e.funding_rail === "CHAIN") {
    const s = await one("SELECT verdict, assessment, encumbrance_clearance_score FROM title_searches WHERE search_id = $1", [searchId]);
    const review = await one("SELECT decision FROM advocate_reviews WHERE search_id = $1", [searchId]);
    const advocate = e.escrow_state === "DISPUTE_HOLD" ? (review?.decision ?? null) : null;
    const d = decideOutcome(s ?? { verdict: null, assessment: null }, action, advocate);
    const evidenceHash = ctx.evidenceHash || sha256(canonicalJson(s?.assessment ?? {}));
    const tx = await settleOnChain(e.escrow_id, d.outcome, { score: Number(s?.encumbrance_clearance_score ?? 0), evidenceHash, advocateReviewed: !!advocate });
    const detail = { outcome: d.outcome, reason: d.reason, ...(tx ? { txHash: tx.hash } : {}), ...(ctx.certificateId ? { certificateId: ctx.certificateId } : {}) };
    if (d.outcome === "INCONCLUSIVE") {
      await transition(e.escrow_id, "DISPUTE_HOLD", ctx.actor, { ...detail, reason: `Funds stay locked: ${d.reason}` });
      return { state: "DISPUTE_HOLD", ...detail };
    }
    const finalState: EscrowState = d.outcome === "VERIFIED_CLEAN" ? "RELEASED_TO_SELLER" : "REFUNDED_TO_BUYER";
    const deposited = Number(e.amount_deposited_inr);
    const amount = d.outcome === "VERIFIED_CLEAN" ? Math.round((deposited - Number(e.platform_escrow_fee_inr)) * 100) / 100 : deposited;
    await q("UPDATE title_escrow_contracts SET settlement_amount_inr = $2, settlement_instruction = $3 WHERE escrow_id = $1", [e.escrow_id, amount, JSON.stringify(detail)]);
    await transition(e.escrow_id, finalState, ctx.actor, detail);
    return { state: finalState, ...detail };
  }

  // Bank rail (CHAIN_MODE=off): oracle-signed instructions to the sandbox trustee bank.
  if (action === "DISPUTE_HOLD") { await transition(e.escrow_id, "DISPUTE_HOLD", ctx.actor, { reason: "Routed to empanelled advocate review" }); return { state: "DISPUTE_HOLD" }; }

  const ref = e.partner_bank_escrow_id.replace(/^SBX-/, "");
  const deposited = Number(e.amount_deposited_inr);
  const legs = action === "RELEASE_TO_SELLER"
    ? [{ beneficiary: "PAYEE_A" as const, amountINR: Math.round((deposited - Number(e.platform_escrow_fee_inr)) * 100) / 100 }, { beneficiary: "PLATFORM_FEE" as const, amountINR: Number(e.platform_escrow_fee_inr) }]
    : [{ beneficiary: "PAYEE_B" as const, amountINR: deposited }];
  const receipts = [];
  for (const leg of legs) {
    if (leg.amountINR <= 0) continue;
    const signed = signInstruction({ escrowReference: ref, escrowId: e.escrow_id, searchId, action, beneficiary: leg.beneficiary, amountINR: leg.amountINR, certificateId: ctx.certificateId, evidenceBundleSha256: ctx.evidenceHash, verdict: ctx.verdict });
    const r = await bank.executePayout({ vaNumber: e.virtual_account_number, ...signed, idempotencyKey: `${e.escrow_id}:${action}:${leg.beneficiary}` });
    receipts.push({ ...leg, utr: r.utr, mode: r.mode, credited: r.credited, oracleSignature: signed.signature.slice(0, 24) + "…" });
  }
  const main = receipts[0];
  await q("UPDATE title_escrow_contracts SET settlement_amount_inr = $2, bank_utr_settlement = $3, settlement_instruction = $4 WHERE escrow_id = $1",
    [e.escrow_id, main?.amountINR ?? 0, main?.utr ?? null, JSON.stringify(receipts)]);
  const finalState: EscrowState = action === "RELEASE_TO_SELLER" ? "RELEASED_TO_SELLER" : "REFUNDED_TO_BUYER";
  await transition(e.escrow_id, finalState, ctx.actor, { receipts, certificateId: ctx.certificateId });
  return { state: finalState, receipts };
}

export async function escrowForSearch(searchId: string) {
  return one("SELECT escrow_id, escrow_state FROM title_escrow_contracts WHERE search_id = $1", [searchId]);
}
