import type { FastifyInstance } from "fastify";
import { config } from "../config.ts";
import { HttpError } from "../http/auth.ts";
import { one } from "../db/pool.ts";
import { chainCtx, chainEnabled, chainTxs, compilerInfo, contractRow, contractSources, fromPaise } from "../chain/chain.ts";

/** In-app block explorer for the TitleEscrow contracts (public, like the certificate ledger). */
export async function chainRoutes(app: FastifyInstance) {
  app.get("/api/v1/chain", async () => {
    if (!chainEnabled()) return { enabled: false };
    try {
      const c = await chainCtx();
      const [block, supply, locked, escrowRow, tokenRow] = await Promise.all([
        c.provider.getBlockNumber(), c.token.totalSupply(), c.escrow.totalLocked(), contractRow("TitleEscrow"), contractRow("TitleShieldINR")
      ]);
      const gas = async (a: string) => Number(await c.provider.getBalance(a)) / 1e18;
      return {
        enabled: true,
        network: {
          name: config.CHAIN_NAME, chainId: c.chainId, mode: config.CHAIN_MODE, latestBlock: block,
          rpcUrl: config.CHAIN_MODE === "embedded" ? `http://localhost:${config.CHAIN_PORT}` : c.rpcUrl.replace(/\/\/([^@/]*)@/, "//"),
          explorer: config.CHAIN_EXPLORER_URL || null
        },
        contracts: {
          TitleEscrow: { address: await c.escrow.getAddress(), deployTx: escrowRow?.deploy_tx, deployBlock: Number(escrowRow?.deploy_block ?? 0), totalLockedINR: fromPaise(locked) },
          TitleShieldINR: { address: await c.token.getAddress(), deployTx: tokenRow?.deploy_tx, deployBlock: Number(tokenRow?.deploy_block ?? 0), symbol: "tINR", decimals: 2, totalSupplyINR: fromPaise(supply) }
        },
        roles: {
          trustee: { address: c.trustee.address, gasETH: await gas(c.trustee.address), does: "Opens escrows, tokenises bank deposits, redeems tINR when the bank pays out" },
          oracle: { address: c.oracle.address, gasETH: await gas(c.oracle.address), does: "The only key that can release, refund or hold an escrow" },
          feeWallet: { address: c.feeWallet, does: "Receives the 0.25% escrow fee on release" }
        },
        compiler: compilerInfo(),
        transactions: await chainTxs({ limit: 60 })
      };
    } catch (e) {
      return { enabled: true, error: (e as Error).message };
    }
  });

  app.get("/api/v1/chain/source", async () => ({ ...compilerInfo(), files: contractSources() }));

  app.get("/api/v1/chain/tx/:hash", async (req) => {
    const { hash } = req.params as { hash: string };
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new HttpError(400, "Not a transaction hash");
    const c = await chainCtx();
    const row = await one("SELECT * FROM chain_transactions WHERE tx_hash = $1", [hash.toLowerCase()]);
    const [t, rc] = await Promise.all([c.provider.getTransaction(hash), c.provider.getTransactionReceipt(hash)]);
    if (!t && !row) throw new HttpError(404, "Transaction not found on this chain");
    const block = rc ? await c.provider.getBlock(rc.blockNumber) : null;
    return {
      hash, label: row?.label ?? null, contract: row?.contract ?? null, method: row?.method ?? null, args: row?.args ?? null, events: row?.events ?? [],
      escrowId: row?.escrow_id ?? null, searchId: row?.search_id ?? null,
      from: t?.from ?? row?.from_addr, to: t?.to ?? rc?.contractAddress ?? row?.to_addr, nonce: t?.nonce ?? null,
      blockNumber: rc?.blockNumber ?? row?.block_number, blockHash: rc?.blockHash ?? null, timestamp: block ? new Date(block.timestamp * 1000).toISOString() : row?.created_at,
      gasUsed: rc ? Number(rc.gasUsed) : row?.gas_used, gasPriceGwei: rc ? Number(rc.gasPrice) / 1e9 : null, status: rc ? (rc.status === 1 ? "Success" : "Reverted") : "Pending",
      input: t?.data ?? null, logsCount: rc?.logs.length ?? 0
    };
  });
}
