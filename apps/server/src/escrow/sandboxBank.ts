import crypto from "node:crypto";
import { config } from "../config.ts";
import { one, q, tx } from "../db/pool.ts";
import { hmacSha256 } from "../crypto/secrets.ts";
import { verifyInstruction, type SettlementInstruction } from "./oracle.ts";

/**
 * Sandbox Trustee Bank — behaves like a programmable escrow bank (Castler / Cashfree
 * Escrow / Yes Bank API banking) with its own ledger tables:
 *  - opens a virtual escrow account with exactly two whitelisted payees + the fee account
 *  - accepts UPI / NEFT / RTGS credits and notifies TitleShield by HMAC-signed webhook
 *  - executes a payout ONLY with a valid Ed25519 oracle signature, unused nonce,
 *    whitelisted beneficiary and sufficient balance (dual control, PDF §6.3)
 * Swap for a real bank by implementing the same BankAdapter interface.
 */

export interface Payee { holderName: string; accountMask: string; ifsc: string; accountToken: string }

export class BankError extends Error { constructor(public code: string, msg: string) { super(msg); } }

const SANDBOX_IFSC = "YESB0TSESCR";
const utr = (prefix: string) => `${prefix}${new Date().toISOString().slice(2, 10).replace(/-/g, "")}${crypto.randomInt(10_000_000, 99_999_999)}`;

export async function openVirtualAccount(i: { escrowReference: string; expectedAmountINR: number; payeeA: Payee; payeeB: Payee; feeAccount: Payee; oraclePublicKeyPem: string; webhookUrl: string }) {
  const va = `TSESC${crypto.randomInt(1e9, 9.99e9)}`;
  await q(`INSERT INTO sandbox_bank_virtual_accounts (va_number, ifsc, escrow_reference, oracle_public_key, payee_a, payee_b, fee_account, expected_amount_inr, webhook_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [va, SANDBOX_IFSC, i.escrowReference, i.oraclePublicKeyPem, JSON.stringify(i.payeeA), JSON.stringify(i.payeeB), JSON.stringify(i.feeAccount), i.expectedAmountINR, i.webhookUrl]);
  return { vaNumber: va, ifsc: SANDBOX_IFSC, bankEscrowId: `SBX-${i.escrowReference}` };
}

/** Penny-drop: ₹1 credit returns the name registered on the account. */
export async function pennyDrop(accountNumber: string, ifsc: string, expectedName: string) {
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new BankError("INVALID_IFSC", `IFSC ${ifsc} is not valid`);
  if (!/^\d{9,18}$/.test(accountNumber)) throw new BankError("INVALID_ACCOUNT", "Account number must be 9–18 digits");
  // Sandbox convention: accounts ending in 0000 belong to someone else (lets you demo a mismatch).
  const nameAtBank = accountNumber.endsWith("0000") ? "Unrelated Account Holder" : expectedName.toUpperCase();
  return { verified: true, nameAtBank, utr: utr("PD") };
}

async function sendWebhook(url: string, payload: object) {
  const body = JSON.stringify(payload);
  const sig = hmacSha256(config.BANK_WEBHOOK_SECRET, body);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Bank-Signature": sig }, body, signal: AbortSignal.timeout(10000) });
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 400 * 2 ** attempt));
  }
  console.error(`sandbox bank: webhook to ${url} failed after retries`);
}

export async function receiveCredit(i: { vaNumber: string; amountINR: number; mode: "UPI" | "NEFT" | "RTGS" | "IMPS"; payerName: string; payerAccountMask: string }) {
  if (i.mode === "UPI" && i.amountINR > 500000) throw new BankError("UPI_LIMIT", "UPI is limited to ₹5,00,000 per transaction. Use NEFT or RTGS for larger advances.");
  if (i.mode === "RTGS" && i.amountINR < 200000) throw new BankError("RTGS_MINIMUM", "RTGS needs at least ₹2,00,000. Use NEFT or UPI.");
  if (i.amountINR <= 0) throw new BankError("INVALID_AMOUNT", "Amount must be positive");
  const ref = utr(i.mode === "UPI" ? "UPI" : i.mode);
  const va = await tx(async (c) => {
    const r = await c.query("SELECT * FROM sandbox_bank_virtual_accounts WHERE va_number = $1 FOR UPDATE", [i.vaNumber]);
    if (!r.rows[0]) throw new BankError("UNKNOWN_ACCOUNT", "Virtual account not found");
    if (r.rows[0].status !== "OPEN") throw new BankError("ACCOUNT_CLOSED", "Virtual account is closed");
    await c.query("UPDATE sandbox_bank_virtual_accounts SET balance_inr = balance_inr + $2 WHERE va_number = $1", [i.vaNumber, i.amountINR]);
    await c.query(`INSERT INTO sandbox_bank_transactions (utr, va_number, kind, amount_inr, mode, counterparty, status) VALUES ($1,$2,'CREDIT',$3,$4,$5,'SUCCESS')`,
      [ref, i.vaNumber, i.amountINR, i.mode, JSON.stringify({ name: i.payerName, account: i.payerAccountMask })]);
    return r.rows[0];
  });
  void sendWebhook(va.webhook_url, { event: "VA_CREDIT", escrowReference: va.escrow_reference, vaNumber: i.vaNumber, utr: ref, amountINR: i.amountINR, mode: i.mode, payer: { name: i.payerName, account: i.payerAccountMask }, at: new Date().toISOString() });
  return { utr: ref };
}

export async function executePayout(i: { vaNumber: string; instruction: SettlementInstruction; signature: string; idempotencyKey: string }) {
  const { instruction } = i;
  // Idempotency: a retried request for the same leg returns the original receipt instead of paying twice.
  const prior = await one("SELECT utr, mode, counterparty FROM sandbox_bank_transactions WHERE idempotency_key = $1", [i.idempotencyKey]);
  if (prior) return { utr: prior.utr, mode: prior.mode, credited: { name: prior.counterparty.name, account: prior.counterparty.account }, duplicate: true };
  const res = await tx(async (c) => {
    const r = await c.query("SELECT * FROM sandbox_bank_virtual_accounts WHERE va_number = $1 FOR UPDATE", [i.vaNumber]);
    const va = r.rows[0];
    if (!va) throw new BankError("UNKNOWN_ACCOUNT", "Virtual account not found");
    if (!verifyInstruction(va.oracle_public_key, instruction, i.signature)) throw new BankError("BAD_SIGNATURE", "Oracle signature invalid — payout refused");
    if (instruction.escrowReference !== va.escrow_reference) throw new BankError("WRONG_ESCROW", "Instruction is for another escrow");
    const allowed = instruction.action === "RELEASE_TO_SELLER" ? ["PAYEE_A", "PLATFORM_FEE"] : ["PAYEE_B"];
    if (!allowed.includes(instruction.beneficiary)) throw new BankError("BENEFICIARY_NOT_ALLOWED", `${instruction.beneficiary} cannot receive funds for ${instruction.action}`);
    const nonce = await c.query("INSERT INTO sandbox_bank_nonces (nonce) VALUES ($1) ON CONFLICT DO NOTHING RETURNING nonce", [instruction.nonce]);
    if (!nonce.rows[0]) throw new BankError("REPLAY", "Instruction nonce already used");
    if (Number(va.balance_inr) + 0.001 < instruction.amountINR) throw new BankError("INSUFFICIENT_FUNDS", "Escrow balance is lower than the instructed amount");
    const payee = instruction.beneficiary === "PAYEE_A" ? va.payee_a : instruction.beneficiary === "PAYEE_B" ? va.payee_b : va.fee_account;
    const mode = instruction.amountINR >= 200000 ? "RTGS" : "IMPS";
    const ref = utr(mode);
    await c.query("UPDATE sandbox_bank_virtual_accounts SET balance_inr = balance_inr - $2 WHERE va_number = $1", [i.vaNumber, instruction.amountINR]);
    await c.query(`INSERT INTO sandbox_bank_transactions (utr, va_number, kind, beneficiary, amount_inr, mode, counterparty, instruction, status, idempotency_key)
                   VALUES ($1,$2,'PAYOUT',$3,$4,$5,$6,$7,'SUCCESS',$8)`,
      [ref, i.vaNumber, instruction.beneficiary, instruction.amountINR, mode, JSON.stringify({ name: payee.holderName, account: payee.accountMask, ifsc: payee.ifsc }), JSON.stringify(instruction), i.idempotencyKey]);
    const left = await c.query("SELECT balance_inr, webhook_url, escrow_reference FROM sandbox_bank_virtual_accounts WHERE va_number = $1", [i.vaNumber]);
    if (Number(left.rows[0].balance_inr) < 0.01) await c.query("UPDATE sandbox_bank_virtual_accounts SET status = 'SETTLED' WHERE va_number = $1", [i.vaNumber]);
    return { utr: ref, mode, payee, webhookUrl: left.rows[0].webhook_url, escrowReference: left.rows[0].escrow_reference };
  });
  void sendWebhook(res.webhookUrl, { event: "PAYOUT_SUCCESS", escrowReference: res.escrowReference, vaNumber: i.vaNumber, utr: res.utr, beneficiary: instruction.beneficiary, amountINR: instruction.amountINR, mode: res.mode, at: new Date().toISOString() });
  return { utr: res.utr, mode: res.mode, credited: { name: res.payee.holderName, account: res.payee.accountMask }, duplicate: false };
}

export async function statement(vaNumber: string) {
  const va = await one("SELECT va_number, ifsc, escrow_reference, balance_inr, expected_amount_inr, status, payee_a, payee_b, created_at FROM sandbox_bank_virtual_accounts WHERE va_number = $1", [vaNumber]);
  if (!va) return null;
  const txns = await q("SELECT utr, kind, beneficiary, amount_inr, mode, counterparty, status, failure_reason, created_at FROM sandbox_bank_transactions WHERE va_number = $1 ORDER BY created_at", [vaNumber]);
  const strip = (p: any) => ({ holderName: p.holderName, accountMask: p.accountMask, ifsc: p.ifsc });
  return { ...va, payee_a: strip(va.payee_a), payee_b: strip(va.payee_b), transactions: txns };
}
