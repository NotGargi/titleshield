import crypto from "node:crypto";
import { ethers } from "ethers";
import { config } from "../config.ts";
import type { ChainCtx } from "./chain.ts";

/**
 * Verification oracle: turns a backend verdict into an EIP-712 attestation that the TitleEscrow
 * contract verifies on-chain. The oracle key ONLY signs; it never sends transactions, and it never
 * leaves the backend. The contract accepts a verdict only if this key signed it, it names the right
 * escrow and search, it hasn't expired, and its nonce hasn't been used.
 */

export const OUTCOME_CODE = { VERIFIED_CLEAN: 1, QUALIFYING_DEFECT: 2, INCONCLUSIVE: 3 } as const;
export type Outcome = keyof typeof OUTCOME_CODE;

export interface Verdict {
  escrowId: string;        // bytes32
  searchId: string;        // bytes32
  outcome: number;         // 1 clean, 2 defect, 3 inconclusive
  score: number;
  evidenceHash: string;    // bytes32 (SHA-256 of the evidence package)
  advocateReviewed: boolean;
  issuedAt: number;        // unix seconds
  expiresAt: number;
  nonce: string;           // bytes32, random
}

export const VERDICT_TYPES = {
  Verdict: [
    { name: "escrowId", type: "bytes32" },
    { name: "searchId", type: "bytes32" },
    { name: "outcome", type: "uint8" },
    { name: "score", type: "uint16" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "advocateReviewed", type: "bool" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" }
  ]
};

export async function domainFor(c: ChainCtx) {
  return { name: "TitleShieldEscrow", version: "1", chainId: c.chainId, verifyingContract: await c.escrow.getAddress() };
}

export function buildVerdict(x: { escrowId: string; searchId: string; outcome: Outcome; score: number; evidenceHash: string; advocateReviewed?: boolean; ttlSeconds?: number; now?: number }): Verdict {
  const now = x.now ?? Math.floor(Date.now() / 1000);
  return {
    escrowId: x.escrowId, searchId: x.searchId, outcome: OUTCOME_CODE[x.outcome],
    score: Math.max(0, Math.min(100, Math.round(x.score))), evidenceHash: x.evidenceHash, advocateReviewed: !!x.advocateReviewed,
    issuedAt: now, expiresAt: now + (x.ttlSeconds ?? config.ATTESTATION_TTL_SECONDS), nonce: "0x" + crypto.randomBytes(32).toString("hex")
  };
}

/** Sign with the oracle key (or another key, which the contract will reject — used by the security check). */
export async function signVerdict(c: ChainCtx, v: Verdict, signer: ethers.BaseWallet = c.oracle) {
  const signature = await signer.signTypedData(await domainFor(c), VERDICT_TYPES, v);
  return { verdict: v, signature, signer: signer.address };
}

/** Off-chain check of the same rule the contract applies (used for display and tests). */
export async function recoverSigner(c: ChainCtx, v: Verdict, signature: string) {
  return ethers.verifyTypedData(await domainFor(c), VERDICT_TYPES, v, signature);
}

export const verdictTuple = (v: Verdict) => [v.escrowId, v.searchId, v.outcome, v.score, v.evidenceHash, v.advocateReviewed, v.issuedAt, v.expiresAt, v.nonce];
