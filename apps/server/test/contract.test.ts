/**
 * TitleEscrow contract tests on the local EVM chain (blueprint §14, "Escrow tests").
 * Every rule is enforced by the contract itself; these tests call it directly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { ethers } from "ethers";

let ok = true;
let ch: typeof import("../src/chain/chain.ts");
let att: typeof import("../src/chain/attestation.ts");
let c: Awaited<ReturnType<typeof import("../src/chain/chain.ts")["chainCtx"]>>;
const Z = ethers.ZeroHash;

beforeAll(async () => {
  try { const { pool } = await import("../src/db/pool.ts"); await pool.query("SELECT 1"); } catch { ok = false; return; }
  const { migrate } = await import("../src/db/migrate.ts");
  await migrate(() => {});
  ch = await import("../src/chain/chain.ts");
  att = await import("../src/chain/attestation.ts");
  await ch.startEmbeddedChain(() => {});
  c = await ch.chainCtx();
});

afterAll(async () => {
  await ch?.stopEmbeddedChain();
  const { pool } = await import("../src/db/pool.ts");
  await pool.end().catch(() => {});
});

const AMOUNT = 120_000_000n; // 12,00,000.00 TST
const FEE = 300_000n;

/** A funded escrow in VerificationPending: returns ids and the buyer/seller wallets. */
async function fundedEscrow(opts: { begin?: boolean; deadlineIn?: number } = {}) {
  const escrowId = ch.keccak(crypto.randomUUID()), searchId = ch.keccak(crypto.randomUUID());
  const buyer = ethers.Wallet.createRandom().connect(c.provider), seller = ethers.Wallet.createRandom();
  await ch.send(c, "create", c.operator, c.escrow, "createEscrow", [escrowId, searchId, seller.address, AMOUNT, FEE, Z, Z, BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineIn ?? 3600))], {});
  await ch.ensureGas(c, buyer.address, {});
  await ch.send(c, "faucet", c.operator, c.token, "faucetTo", [buyer.address, AMOUNT], {});
  await ch.send(c, "approve", buyer as any, c.token, "approve", [await c.escrow.getAddress(), AMOUNT], {});
  await ch.send(c, "deposit", buyer as any, c.escrow, "deposit", [escrowId], {});
  if (opts.begin !== false) await ch.send(c, "begin", c.operator, c.escrow, "beginVerification", [escrowId], {});
  return { escrowId, searchId, buyer, seller };
}

async function verdict(e: { escrowId: string; searchId: string }, outcome: "VERIFIED_CLEAN" | "QUALIFYING_DEFECT" | "INCONCLUSIVE", extra: Partial<Parameters<typeof att.buildVerdict>[0]> = {}, signer?: ethers.BaseWallet) {
  const v = att.buildVerdict({ escrowId: e.escrowId, searchId: e.searchId, outcome, score: outcome === "VERIFIED_CLEAN" ? 100 : outcome === "QUALIFYING_DEFECT" ? 0 : 72, evidenceHash: ch.keccak("evidence"), ...extra });
  return att.signVerdict(c, v, signer);
}
const submit = (s: { verdict: any; signature: string }) => ch.send(c, "settle", c.operator, c.escrow, "settle", [att.verdictTuple(s.verdict), s.signature], {});
const bal = async (a: string) => BigInt(await c.token.balanceOf(a));
const status = async (id: string) => ch.STATUS[Number((await c.escrow.escrows(id)).status)];

describe("TitleEscrow: custody", () => {
  it("a buyer deposits test tokens and the contract holds them; a second deposit is rejected", async () => {
    if (!ok) return;
    const e = await fundedEscrow({ begin: false });
    expect(await status(e.escrowId)).toBe("Funded");
    expect((await c.escrow.escrows(e.escrowId)).buyer).toBe(e.buyer.address);
    expect(await bal(e.buyer.address)).toBe(0n);
    const lockedBefore = BigInt(await c.escrow.totalLocked());
    expect(lockedBefore).toBeGreaterThanOrEqual(AMOUNT);
    await ch.send(c, "faucet", c.operator, c.token, "faucetTo", [e.buyer.address, AMOUNT], {});
    await ch.send(c, "approve", e.buyer as any, c.token, "approve", [await c.escrow.getAddress(), AMOUNT], {});
    await expect(ch.send(c, "deposit again", e.buyer as any, c.escrow, "deposit", [e.escrowId], {})).rejects.toThrow(/BadState\(2\)/);
  });

  it("only the operator can create an escrow or start verification", async () => {
    if (!ok) return;
    await expect(ch.send(c, "create", c.oracle, c.escrow, "createEscrow", [ch.keccak("x"), Z, c.feeWallet, 1n, 0n, Z, Z, 9999999999n], {})).rejects.toThrow(/NotOperator/);
  });
});

describe("TitleEscrow: attested settlement", () => {
  it("an authorised clean-title attestation releases the right amounts to the seller and the fee wallet", async () => {
    if (!ok) return;
    const e = await fundedEscrow();
    const feeBefore = await bal(c.feeWallet);
    const tx = await submit(await verdict(e, "VERIFIED_CLEAN"));
    expect(tx.events.map((x) => x.event)).toEqual(expect.arrayContaining(["VerdictAccepted", "Released"]));
    expect(await bal(e.seller.address)).toBe(AMOUNT - FEE);
    expect((await bal(c.feeWallet)) - feeBefore).toBe(FEE);
    expect(await status(e.escrowId)).toBe("Released");
  });

  it("an authorised qualifying-defect attestation refunds the whole deposit to the buyer", async () => {
    if (!ok) return;
    const e = await fundedEscrow();
    await submit(await verdict(e, "QUALIFYING_DEFECT"));
    expect(await bal(e.buyer.address)).toBe(AMOUNT);
    expect(await bal(e.seller.address)).toBe(0n);
    expect(await status(e.escrowId)).toBe("Refunded");
  });

  it("rejects a verdict signed by anyone other than the oracle (a forged verdict from the frontend)", async () => {
    if (!ok) return;
    const e = await fundedEscrow();
    await expect(submit(await verdict(e, "VERIFIED_CLEAN", {}, ethers.Wallet.createRandom()))).rejects.toThrow(/UnauthorizedSigner/);
    await expect(submit(await verdict(e, "VERIFIED_CLEAN", {}, c.operator))).rejects.toThrow(/UnauthorizedSigner/);
    expect(await status(e.escrowId)).toBe("VerificationPending");
  });

  it("rejects a replayed attestation, even on another escrow", async () => {
    if (!ok) return;
    const a = await fundedEscrow(), b = await fundedEscrow();
    const s = await verdict(a, "QUALIFYING_DEFECT");
    await submit(s);
    await expect(submit(s)).rejects.toThrow(/BadState\(6\)/);                    // already refunded
    const forB = await verdict(b, "QUALIFYING_DEFECT", {});
    forB.verdict.nonce = s.verdict.nonce;                                           // same nonce, re-signed
    const resigned = await att.signVerdict(c, forB.verdict);
    await expect(submit(resigned)).rejects.toThrow(/NonceAlreadyUsed/);
  });

  it("a signature for one escrow cannot settle another", async () => {
    if (!ok) return;
    const a = await fundedEscrow(), b = await fundedEscrow();
    const s = await verdict(a, "VERIFIED_CLEAN");
    await expect(submit({ verdict: { ...s.verdict, escrowId: b.escrowId, searchId: b.searchId }, signature: s.signature })).rejects.toThrow(/UnauthorizedSigner/);
    await expect(submit(await verdict({ escrowId: a.escrowId, searchId: b.searchId }, "VERIFIED_CLEAN"))).rejects.toThrow(/WrongEscrowOrSearch/);
  });

  it("rejects an expired attestation and a malformed signature", async () => {
    if (!ok) return;
    const e = await fundedEscrow();
    await expect(submit(await verdict(e, "VERIFIED_CLEAN", { now: Math.floor(Date.now() / 1000) - 7200, ttlSeconds: 60 }))).rejects.toThrow(/AttestationExpired/);
    const s = await verdict(e, "VERIFIED_CLEAN");
    await expect(submit({ verdict: s.verdict, signature: s.signature.slice(0, 130) })).rejects.toThrow(/BadSignature/);
  });

  it("double settlement is impossible", async () => {
    if (!ok) return;
    const e = await fundedEscrow();
    await submit(await verdict(e, "VERIFIED_CLEAN"));
    await expect(submit(await verdict(e, "QUALIFYING_DEFECT"))).rejects.toThrow(/BadState\(5\)/);
    await expect(submit(await verdict(e, "VERIFIED_CLEAN"))).rejects.toThrow(/BadState\(5\)/);
  });

  it("inconclusive evidence keeps the tokens locked; release then needs an advocate-reviewed verdict", async () => {
    if (!ok) return;
    const e = await fundedEscrow();
    await submit(await verdict(e, "INCONCLUSIVE"));
    expect(await status(e.escrowId)).toBe("Disputed");
    expect(await bal(e.seller.address)).toBe(0n);
    expect(await bal(e.buyer.address)).toBe(0n);
    await expect(submit(await verdict(e, "VERIFIED_CLEAN", { score: 80 }))).rejects.toThrow(/TitleNotClear\(80\)/);
    await expect(submit(await verdict(e, "INCONCLUSIVE"))).rejects.toThrow(/BadState\(4\)/);
    await submit(await verdict(e, "VERIFIED_CLEAN", { score: 80, advocateReviewed: true }));
    expect(await bal(e.seller.address)).toBe(AMOUNT - FEE);
  });

  it("a clean verdict below the clean-title score is refused without review", async () => {
    if (!ok) return;
    const e = await fundedEscrow();
    await expect(submit(await verdict(e, "VERIFIED_CLEAN", { score: 89 }))).rejects.toThrow(/TitleNotClear\(89\)/);
    await expect(submit(await verdict(e, "VERIFIED_CLEAN", { score: 75, advocateReviewed: true }))).rejects.toThrow(/TitleNotClear\(75\)/); // review flag only counts after a dispute
  });

  it("no verdict before verification has started", async () => {
    if (!ok) return;
    const e = await fundedEscrow({ begin: false });
    await expect(submit(await verdict(e, "VERIFIED_CLEAN"))).rejects.toThrow(/BadState\(2\)/);
  });
});

describe("TitleEscrow: deadline and roles", () => {
  it("after the deadline anyone can return the deposit to the buyer, never to the seller", async () => {
    if (!ok) return;
    const e = await fundedEscrow({ deadlineIn: 120 });
    await expect(ch.send(c, "early", c.operator, c.escrow, "refundAfterDeadline", [e.escrowId], {})).rejects.toThrow(/DeadlineNotReached/);
    await ch.rpc("evm_increaseTime", [600]);
    await ch.rpc("evm_mine", []);
    await ch.send(c, "late", c.oracle, c.escrow, "refundAfterDeadline", [e.escrowId], {});
    expect(await bal(e.buyer.address)).toBe(AMOUNT);
    expect(await bal(e.seller.address)).toBe(0n);
    await expect(submit(await verdict(e, "VERIFIED_CLEAN", { now: Math.floor(Date.now() / 1000) + 600 }))).rejects.toThrow(/BadState\(6\)/);
  });

  it("only the owner can rotate the oracle", async () => {
    if (!ok) return;
    await expect(ch.send(c, "rotate", c.oracle, c.escrow, "setOracle", [c.oracle.address], {})).rejects.toThrow(/NotOwner/);
    expect(await c.escrow.oracle()).toBe(c.oracle.address);
  });
});
