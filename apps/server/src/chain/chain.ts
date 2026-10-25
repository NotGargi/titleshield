import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { config, SERVER_ROOT } from "../config.ts";
import { one, q, tx as dbTx } from "../db/pool.ts";
import { publish } from "../events/bus.ts";
import { CONTRACTS_DIR, SOURCES } from "./compile.ts";

/**
 * Blockchain layer for the title escrow (Web3 smart-contract escrow).
 *
 *   TestToken (TST)   mock ERC-20 for the demo: no monetary value, does not represent rupees
 *   TitleEscrow       holds the buyer's deposited tokens; releases or refunds them only on an
 *                     oracle-signed (EIP-712) verdict bound to the escrow, search, evidence hash and expiry
 *
 * Keys (separate): the OPERATOR registers escrows, marks verification started and relays transactions;
 * the ORACLE only signs verdicts (it never sends transactions); the FEE wallet receives the release fee.
 *
 * CHAIN_MODE=embedded starts a local Ethereum node inside the API (state kept in data/chain);
 * CHAIN_MODE=rpc uses any EVM JSON-RPC endpoint (e.g. a public testnet) with funded keys.
 */

const artifacts = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, "src/chain/artifacts.json"), "utf8"));
export const ABI = { token: artifacts.TestToken.abi, escrow: artifacts.TitleEscrow.abi };
/** Contract versions: a new version deploys fresh contracts instead of reusing old ones on the same chain. */
const VERSIONED = { TestToken: "TestToken@1", TitleEscrow: "TitleEscrow@2" } as const;
const tokenIface = new ethers.Interface(ABI.token);
const escrowIface = new ethers.Interface(ABI.escrow);

export class ChainError extends Error { constructor(message: string, public data?: unknown) { super(message); } }

export const chainEnabled = () => config.CHAIN_MODE !== "off";

// ---------- keys ----------
/** `trustee` is the operator key (name kept so existing key files stay valid). */
interface Keys { trustee: string; oracle: string; fee: string }
const keysFile = () => path.join(config.CHAIN_DIR, "keys.json");

function loadOrCreateKeys(): Keys {
  if (config.CHAIN_MODE === "rpc") {
    const op = config.CHAIN_OPERATOR_KEY || config.CHAIN_TRUSTEE_KEY;
    if (!op || !config.CHAIN_ORACLE_KEY) throw new ChainError("CHAIN_MODE=rpc needs CHAIN_OPERATOR_KEY and CHAIN_ORACLE_KEY");
    return { trustee: op, oracle: config.CHAIN_ORACLE_KEY, fee: ethers.keccak256(ethers.toUtf8Bytes(`fee:${op}`)) };
  }
  try { return JSON.parse(fs.readFileSync(keysFile(), "utf8")); } catch { /* first run */ }
  // New keys mean a new chain: drop any chain database that was funded for other keys.
  fs.rmSync(path.join(config.CHAIN_DIR, "db"), { recursive: true, force: true });
  fs.mkdirSync(config.CHAIN_DIR, { recursive: true });
  const k: Keys = { trustee: ethers.Wallet.createRandom().privateKey, oracle: ethers.Wallet.createRandom().privateKey, fee: ethers.Wallet.createRandom().privateKey };
  fs.writeFileSync(keysFile(), JSON.stringify(k, null, 2), { mode: 0o600 });
  return k;
}

// ---------- embedded node ----------
let server: any = null;

/** Starts the local chain inside this process (API only; the Temporal worker connects over JSON-RPC). */
export async function startEmbeddedChain(log: (m: string) => void = console.log) {
  if (config.CHAIN_MODE !== "embedded" || config.CHAIN_RPC_URL || server) return;
  const keys = loadOrCreateKeys();
  fs.mkdirSync(path.join(config.CHAIN_DIR, "db"), { recursive: true });
  // Ganache prints a notice when its optional native WebSocket build doesn't match this Node version; it works without it.
  const quiet = (orig: (...a: any[]) => void) => (...a: any[]) => { const t = a.map(String).join(" "); if (!/µWS|uws|Require stack|Falling back to a NodeJS|^\s*-\s|^\s*$/.test(t)) orig(...a); };
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = quiet(saved.log); console.error = quiet(saved.error); console.warn = quiet(saved.warn);
  let ganache: any;
  try { ganache = (await import("ganache")).default; } finally { Object.assign(console, saved); }
  const s = ganache.server({
    logging: { quiet: true },
    chain: { chainId: config.CHAIN_ID, networkId: config.CHAIN_ID, hardfork: "shanghai" },
    miner: { instamine: "eager", blockGasLimit: "0x1C9C380" },
    wallet: { accounts: [keys.trustee, keys.oracle, keys.fee].map((secretKey) => ({ secretKey, balance: "0x3635C9ADC5DEA00000" })) }, // 1,000 ETH each for gas
    database: { dbPath: path.join(config.CHAIN_DIR, "db") }
  });
  try {
    await new Promise<void>((res, rej) => s.listen(config.CHAIN_PORT, config.CHAIN_HOST, (e: Error | null) => (e ? rej(e) : res())));
    server = s;
    log(`Local blockchain on http://${config.CHAIN_HOST}:${config.CHAIN_PORT} (chain id ${config.CHAIN_ID})`);
  } catch (e) {
    await s.close().catch(() => {});
    // Another TitleShield process may already host it (e.g. during a restart); connect to that one.
    log(`Local blockchain not started here (${(e as Error).message}); connecting to http://${config.CHAIN_HOST}:${config.CHAIN_PORT}`);
  }
}

export async function stopEmbeddedChain() {
  ctxP = null;
  nextNonce.clear();
  if (server) { const s = server; server = null; await s.close().catch(() => {}); }
}

// ---------- context ----------
export interface ChainCtx {
  provider: ethers.JsonRpcProvider;
  rpcUrl: string;
  chainId: number;
  chainKey: string;
  operator: ethers.Wallet;
  oracle: ethers.Wallet;
  feeWallet: string;
  keys: Keys;
  token: ethers.Contract;
  escrow: ethers.Contract;
}

let ctxP: Promise<ChainCtx> | null = null;

export function rpcUrl() {
  return config.CHAIN_MODE === "rpc" || config.CHAIN_RPC_URL ? config.CHAIN_RPC_URL : `http://${config.CHAIN_HOST === "0.0.0.0" ? "127.0.0.1" : config.CHAIN_HOST}:${config.CHAIN_PORT}`;
}

async function rawRpc(url: string, method: string, params: unknown[] = []) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  const j: any = await r.json();
  if (j.error) throw new ChainError(j.error.message, typeof j.error.data === "string" ? j.error.data : j.error.data?.result ?? j.error.data?.data);
  return j.result;
}

export function chainCtx(): Promise<ChainCtx> {
  if (!chainEnabled()) return Promise.reject(new ChainError("Blockchain escrow is off (CHAIN_MODE=off)"));
  if (!ctxP) ctxP = init().catch((e) => { ctxP = null; throw e; });
  return ctxP;
}

async function init(): Promise<ChainCtx> {
  const url = rpcUrl();
  if (!url) throw new ChainError("CHAIN_RPC_URL is not set");
  let chainIdHex: string;
  try { chainIdHex = await rawRpc(url, "eth_chainId"); } catch (e) { throw new ChainError(`Blockchain node not reachable at ${url}: ${(e as Error).message}`); }
  const chainId = Number(chainIdHex);
  const network = ethers.Network.from(chainId);
  const provider = new ethers.JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 1 });
  provider.pollingInterval = 250;
  const genesis = await provider.getBlock(0);
  const chainKey = `${chainId}:${genesis?.hash ?? "unknown"}`;
  const keys = loadOrCreateKeys();
  const operator = new ethers.Wallet(keys.trustee, provider), oracle = new ethers.Wallet(keys.oracle, provider);
  const feeWallet = config.CHAIN_FEE_WALLET || new ethers.Wallet(keys.fee).address;
  const base = { provider, rpcUrl: url, chainId, chainKey, operator, oracle, feeWallet, keys };

  const addresses = await dbTx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('titleshield-chain-deploy'))");
    const rows = (await c.query("SELECT name, address FROM chain_contracts WHERE chain_key = $1", [chainKey])).rows;
    const have = Object.fromEntries(rows.map((r: any) => [r.name, r.address.trim()]));
    const tok = have[VERSIONED.TestToken], esc = have[VERSIONED.TitleEscrow];
    if (tok && esc && (await provider.getCode(esc)) !== "0x" && (await provider.getCode(tok)) !== "0x") return { TestToken: tok, TitleEscrow: esc };
    // First run on this chain (or a new contract version): deploy the test token and the escrow.
    const tokenDep = await deploy(base, "TestToken", [], "Deploy TestToken (TST, mock ERC-20)");
    const escrowDep = await deploy(base, "TitleEscrow", [tokenDep.address, operator.address, oracle.address, feeWallet], "Deploy TitleEscrow contract");
    for (const [name, d] of [[VERSIONED.TestToken, tokenDep], [VERSIONED.TitleEscrow, escrowDep]] as const) {
      await c.query(`INSERT INTO chain_contracts (chain_key, name, address, deploy_tx, deploy_block) VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (chain_key, name) DO UPDATE SET address = EXCLUDED.address, deploy_tx = EXCLUDED.deploy_tx, deploy_block = EXCLUDED.deploy_block, created_at = NOW()`,
        [chainKey, name, d.address, d.hash, d.block]);
    }
    return { TestToken: tokenDep.address, TitleEscrow: escrowDep.address };
  });
  return { ...base, token: new ethers.Contract(addresses.TestToken, ABI.token, provider), escrow: new ethers.Contract(addresses.TitleEscrow, ABI.escrow, provider) };
}

// ---------- sending ----------
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

// Ganache's "pending" count can lag behind "latest"; sends are serialised per key, so track the next nonce here.
const nextNonce = new Map<string, number>();
async function takeNonce(provider: ethers.JsonRpcProvider, addr: string) {
  const [latest, pending] = await Promise.all([provider.getTransactionCount(addr, "latest"), provider.getTransactionCount(addr, "pending")]);
  const n = Math.max(latest, pending, nextNonce.get(addr) ?? 0);
  nextNonce.set(addr, n + 1);
  return n;
}

async function waitReceipt(provider: ethers.JsonRpcProvider, hash: string) {
  for (let i = 0; i < 600; i++) {
    const rc = await provider.getTransactionReceipt(hash);
    if (rc) return rc;
    await new Promise((r) => setTimeout(r, i < 20 ? 150 : 1000));
  }
  throw new ChainError(`Transaction ${hash} was not mined in time`);
}

const fmt = (v: unknown): unknown => (typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(fmt) : v);

function decodeLogs(logs: readonly ethers.Log[], addrs: Record<string, string>) {
  const out: Array<{ contract: string; event: string; args: Record<string, unknown> }> = [];
  for (const l of logs) {
    const name = Object.entries(addrs).find(([, a]) => a && a.toLowerCase() === l.address.toLowerCase())?.[0];
    const iface = name === "TestToken" ? tokenIface : name === "TitleEscrow" ? escrowIface : null;
    if (!iface) continue;
    try {
      const p = iface.parseLog({ topics: [...l.topics], data: l.data });
      if (p) out.push({ contract: name!, event: p.name, args: Object.fromEntries(p.fragment.inputs.map((inp, i) => [inp.name, fmt(p.args[i])])) });
    } catch { /* not ours */ }
  }
  return out;
}

function explain(e: any, iface: ethers.Interface): ChainError {
  let data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (data && typeof data === "object") data = data.result ?? data.data;
  if (typeof data === "string" && data.length >= 10) {
    try { const pe = iface.parseError(data); if (pe) return new ChainError(`Smart contract refused: ${pe.name}(${pe.args.map((a) => String(a)).join(", ")})`); } catch { /* unknown */ }
  }
  return new ChainError(e?.shortMessage ?? e?.message ?? String(e));
}

interface Meta { escrowId?: string | null; searchId?: string | null }

async function record(c: Pick<ChainCtx, "chainKey">, rc: ethers.TransactionReceipt, label: string, contract: string, method: string, args: unknown[], events: unknown[], meta: Meta) {
  await q(`INSERT INTO chain_transactions (tx_hash, chain_key, escrow_id, search_id, label, contract, method, from_addr, to_addr, block_number, gas_used, status, args, events)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (tx_hash) DO NOTHING`,
    [rc.hash, c.chainKey, meta.escrowId ?? null, meta.searchId ?? null, label, contract, method, rc.from, rc.to ?? rc.contractAddress, rc.blockNumber, Number(rc.gasUsed), rc.status, JSON.stringify(fmt(args)), JSON.stringify(events)]);
  if (meta.searchId) await publish(meta.searchId, "chain_tx", { hash: rc.hash, label, contract, method, block: rc.blockNumber, gasUsed: Number(rc.gasUsed), events });
}

async function deploy(c: Omit<ChainCtx, "token" | "escrow">, name: "TestToken" | "TitleEscrow", args: unknown[], label: string) {
  return serial(c.operator.address, async () => {
    const f = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].bytecode, c.operator);
    const req = await f.getDeployTransaction(...args);
    const sent = await c.operator.sendTransaction({ ...req, nonce: await takeNonce(c.provider, c.operator.address) }).catch((e) => { nextNonce.delete(c.operator.address); throw e; });
    const rc = await waitReceipt(c.provider, sent.hash);
    if (rc.status !== 1 || !rc.contractAddress) throw new ChainError(`${label} failed`);
    await record(c, rc, label, name, "constructor", args, [], {});
    return { address: rc.contractAddress, hash: rc.hash, block: rc.blockNumber };
  });
}

export interface SentTx { hash: string; block: number; gasUsed: number; events: Array<{ contract: string; event: string; args: Record<string, unknown> }> }

export { explain };
export async function send(c: ChainCtx, label: string, signer: ethers.Wallet, contract: ethers.Contract, method: string, args: unknown[], meta: Meta): Promise<SentTx> {
  const to = await contract.getAddress();
  const iface = contract.interface;
  const name = to.toLowerCase() === (await c.token.getAddress()).toLowerCase() ? "TestToken" : "TitleEscrow";
  if (signer.provider !== c.provider) signer = signer.connect(c.provider);
  return serial(signer.address, async () => {
    const data = iface.encodeFunctionData(method, args);
    // Simulate first: a contract rule that refuses the call (e.g. TitleNotClear) is reported with its name.
    try { await rawRpc(c.rpcUrl, "eth_call", [{ from: signer.address, to, data }, "latest"]); } catch (e) { throw explain(e, iface); }
    let sent: ethers.TransactionResponse | null = null;
    for (let attempt = 0; !sent; attempt++) {
      try {
        sent = await signer.sendTransaction({ to, data, nonce: await takeNonce(c.provider, signer.address) });
      } catch (e: any) {
        nextNonce.delete(signer.address);
        // Another process (e.g. the Temporal worker) may have used this key's nonce: retry once.
        if (attempt === 0 && /nonce/i.test(JSON.stringify(e?.error ?? e?.message ?? ""))) continue;
        throw explain(e, iface);
      }
    }
    const rc = await waitReceipt(c.provider, sent.hash);
    if (rc.status !== 1) throw new ChainError(`${label}: transaction reverted (${rc.hash})`);
    const events = decodeLogs(rc.logs, { TestToken: await c.token.getAddress(), TitleEscrow: await c.escrow.getAddress() });
    await record(c, rc, label, name, method, args, events, meta);
    return { hash: rc.hash, block: rc.blockNumber, gasUsed: Number(rc.gasUsed), events };
  });
}

// ---------- helpers ----------
/** TST has 2 decimals, so the escrow uses the agreed advance figure as a readable test amount (not rupees). */
export const toUnits = (amount: number | string) => BigInt(Math.round(Number(amount) * 100));
export const fromUnits = (u: bigint | string | number) => Number(BigInt(u)) / 100;
export const keccak = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
export const bytes32OfSha256 = (hex: string | null | undefined) => (hex && /^[0-9a-f]{64}$/i.test(hex) ? `0x${hex.toLowerCase()}` : ethers.ZeroHash);
export const escrowKey = (escrowId: string) => keccak(`titleshield-escrow:${escrowId}`);
export const searchKey = (searchId: string) => keccak(`titleshield-search:${searchId}`);

/** Demo wallet for a party, derived from the operator key and the escrow id (recoverable, never reused). */
export function partyWallet(c: Pick<ChainCtx, "keys">, escrowId: string, role: "buyer" | "seller") {
  return new ethers.Wallet(ethers.keccak256(ethers.concat([c.keys.trustee, ethers.toUtf8Bytes(`${escrowId}:${role}`)])));
}

/** Top up a demo wallet with gas from the operator (local chain: plenty; testnet: a small amount). */
export async function ensureGas(c: ChainCtx, address: string, meta: Meta) {
  const min = ethers.parseEther(config.CHAIN_MODE === "embedded" ? "0.5" : "0.002");
  if ((await c.provider.getBalance(address)) >= min) return null;
  return serial(c.operator.address, async () => {
    const sent = await c.operator.sendTransaction({ to: address, value: min, nonce: await takeNonce(c.provider, c.operator.address) }).catch((e) => { nextNonce.delete(c.operator.address); throw e; });
    const rc = await waitReceipt(c.provider, sent.hash);
    await record(c, rc, "Send gas to the buyer's demo wallet", "native", "transfer", [address, ethers.formatEther(min) + " ETH"], [], meta);
    return rc.hash;
  });
}

export async function rpc(method: string, params: unknown[] = []) { return rawRpc((await chainCtx()).rpcUrl, method, params); }

export const STATUS = ["None", "Created", "Funded", "VerificationPending", "Disputed", "Released", "Refunded"] as const;
export const OUTCOME = { VERIFIED_CLEAN: 1, QUALIFYING_DEFECT: 2, INCONCLUSIVE: 3 } as const;

export function contractSources() {
  return SOURCES.map((f) => ({ file: `contracts/${f}`, source: fs.readFileSync(path.join(CONTRACTS_DIR, f), "utf8") }));
}

export const compilerInfo = () => ({ compiler: artifacts.compiler as string, settings: artifacts.settings });

export async function chainTxs(where: { escrowId?: string; limit?: number } = {}) {
  const c = await chainCtx();
  return q(`SELECT tx_hash, label, contract, method, from_addr, to_addr, block_number, gas_used, status, args, events, escrow_id, search_id, created_at
            FROM chain_transactions WHERE chain_key = $1 ${where.escrowId ? "AND escrow_id = $2" : ""} ORDER BY block_number ${where.escrowId ? "ASC" : "DESC"}, created_at DESC LIMIT ${where.limit ?? 100}`,
    where.escrowId ? [c.chainKey, where.escrowId] : [c.chainKey]);
}

export async function contractRow(name: string) {
  const c = await chainCtx();
  return one("SELECT address, deploy_tx, deploy_block, created_at FROM chain_contracts WHERE chain_key = $1 AND name = $2", [c.chainKey, VERSIONED[name as keyof typeof VERSIONED] ?? name]);
}
