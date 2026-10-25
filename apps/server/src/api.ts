import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { getSecret } from "./settings.ts";
import { migrate } from "./db/migrate.ts";
import { ensurePki } from "./crypto/pki.ts";
import { startInlineScheduler } from "./workflows/engine.ts";
import { anchorPendingHours } from "./ledger/ledger.ts";
import { chainCtx, chainEnabled, startEmbeddedChain } from "./chain/chain.ts";

async function main() {
  await migrate();
  ensurePki();
  await startEmbeddedChain();
  const app = await buildApp();
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  startInlineScheduler();
  // Hourly Merkle anchoring of the certificate ledger (PDF §7.2)
  setInterval(() => anchorPendingHours().catch((e) => app.log.error(e)), 10 * 60_000).unref();
  const tf = await getSecret("TINYFISH_API_KEY"), gm = await getSecret("GEMINI_API_KEY");
  if (chainEnabled()) {
    chainCtx().then(async (c) => app.log.info(`Smart contracts on ${config.CHAIN_NAME} (chain ${c.chainId}): TitleEscrow ${await c.escrow.getAddress()} · TST test token ${await c.token.getAddress()}`))
      .catch((e) => app.log.error(`Blockchain escrow unavailable: ${(e as Error).message}`));
  }
  app.log.info(`TitleShield API on ${config.PUBLIC_BASE_URL} · TinyFish free tier: ${tf.value ? "key set" : "NO KEY (add it on the Settings page)"} · document AI: ${gm.value ? config.GEMINI_MODEL : "PDF text only"} · workflows: ${config.WORKFLOW_ENGINE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
