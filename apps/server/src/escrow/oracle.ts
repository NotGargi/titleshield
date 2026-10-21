import crypto from "node:crypto";
import { canonicalJson } from "@titleshield/core";
import { oracleKeys } from "../crypto/pki.ts";

/**
 * TitleVerificationOracle (PDF §6.3): the only component holding the Ed25519 key that
 * authorises money movement. The trustee bank verifies this signature (with the public
 * key registered when the escrow account was opened) before executing any payout, so
 * a compromised API server cannot move funds on its own.
 */

export interface SettlementInstruction {
  version: 1;
  escrowReference: string;
  escrowId: string;
  searchId: string;
  action: "RELEASE_TO_SELLER" | "REFUND_TO_BUYER";
  beneficiary: "PAYEE_A" | "PAYEE_B" | "PLATFORM_FEE";
  amountINR: number;
  certificateId: string;
  evidenceBundleSha256: string;
  verdict: string;
  nonce: string;
  issuedAt: string;
}

export function signInstruction(i: Omit<SettlementInstruction, "version" | "nonce" | "issuedAt">): { instruction: SettlementInstruction; signature: string } {
  const instruction: SettlementInstruction = { version: 1, ...i, nonce: crypto.randomUUID(), issuedAt: new Date().toISOString() };
  const signature = crypto.sign(null, Buffer.from(canonicalJson(instruction)), oracleKeys().privateKey).toString("base64");
  return { instruction, signature };
}

export function verifyInstruction(publicKeyPem: string, instruction: SettlementInstruction, signatureB64: string): boolean {
  try {
    return crypto.verify(null, Buffer.from(canonicalJson(instruction)), crypto.createPublicKey(publicKeyPem), Buffer.from(signatureB64, "base64"));
  } catch { return false; }
}

export const oraclePublicKeyPem = () => oracleKeys().publicKeyPem;
