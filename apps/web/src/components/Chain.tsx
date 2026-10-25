import { Link } from "react-router-dom";

/** Small pieces for showing on-chain data: addresses, transaction hashes, TST amounts and decoded events. */

export const short = (h: string | null | undefined, n = 6) => (h ? `${h.slice(0, n + 2)}…${h.slice(-4)}` : "—");
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x" + "00".repeat(32);

/** TST (test token) has 2 decimals: on-chain integers are hundredths. It has no monetary value. */
export const tst = (units: string | number | null | undefined) =>
  units == null ? "—" : `${(Number(units) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })} TST`;
export const tstAmount = (amount: number | null | undefined) => (amount == null ? "—" : `${Number(amount).toLocaleString("en-IN", { maximumFractionDigits: 2 })} TST`);

export const OUTCOME_LABEL: Record<number, string> = { 1: "Verified clean", 2: "Qualifying defect", 3: "Inconclusive" };

/** Transaction link: the public testnet explorer when configured, otherwise the in-app explorer. */
export function TxLink({ hash, explorer }: { hash: string; explorer?: string | null }) {
  if (explorer) return <a className="mono small" href={`${explorer.replace(/\/$/, "")}/tx/${hash}`} target="_blank" rel="noreferrer" title={hash}>{short(hash, 8)} ↗</a>;
  return <Link className="mono small" to={`/chain/tx/${hash}`} title={hash}>{short(hash, 8)}</Link>;
}

export function Addr({ a, names, explorer }: { a: string | null | undefined; names?: Record<string, string>; explorer?: string | null }) {
  if (!a) return <span className="muted">—</span>;
  if (a.toLowerCase() === ZERO_ADDR) return <span className="small muted">0x0 (mint)</span>;
  const label = names && Object.entries(names).find(([addr]) => addr.toLowerCase() === a.toLowerCase())?.[1];
  const body = <>{short(a)}{label && <span className="addr-tag">{label}</span>}</>;
  return explorer
    ? <a className="mono small" href={`${explorer.replace(/\/$/, "")}/address/${a}`} target="_blank" rel="noreferrer" title={a}>{body}</a>
    : <span className="mono small" title={a}>{body}</span>;
}

export const isZeroHash = (h: string | null | undefined) => !h || h === ZERO_HASH;

/** One decoded event as a readable line. */
export function EventLine({ e, names }: { e: { contract: string; event: string; args: Record<string, any> }; names?: Record<string, string> }) {
  const a = e.args;
  let text: React.ReactNode = Object.entries(a).map(([k, v]) => `${k}: ${String(v).length > 20 ? short(String(v)) : v}`).join(" · ");
  if (e.event === "EscrowCreated") text = <>escrow created for {tst(a.amount)} (fee {tst(a.fee)}) · seller <Addr a={a.seller} names={names} /></>;
  if (e.event === "Deposited") text = <>{tst(a.amount)} deposited by buyer <Addr a={a.buyer} names={names} /> and locked in the contract</>;
  if (e.event === "VerificationStarted") text = <>title search started for this escrow</>;
  if (e.event === "VerdictAccepted") text = <>oracle-signed verdict accepted: <b>{OUTCOME_LABEL[Number(a.outcome)] ?? a.outcome}</b> · score {a.score}{String(a.advocateReviewed) === "true" ? " · advocate reviewed" : ""} · nonce {short(String(a.nonce))}</>;
  if (e.event === "Disputed") text = <>inconclusive: tokens stay locked until a reviewed verdict</>;
  if (e.event === "Released") text = <>{tst(a.toSeller)} released to seller <Addr a={a.seller} names={names} /> · fee {tst(a.fee)}</>;
  if (e.event === "Refunded") text = <>{tst(a.amount)} refunded to buyer <Addr a={a.buyer} names={names} /> · {a.reason}</>;
  if (e.event === "OracleChanged") text = <>oracle set to <Addr a={a.current} names={names} /></>;
  if (e.event === "Approval") text = <><Addr a={a.owner} names={names} /> allows <Addr a={a.spender} names={names} /> to take {tst(a.value)}</>;
  if (e.event === "Transfer") {
    text = a.from?.toLowerCase() === ZERO_ADDR ? <>faucet minted {tst(a.value)} to <Addr a={a.to} names={names} /></>
      : <>{tst(a.value)} <Addr a={a.from} names={names} /> → <Addr a={a.to} names={names} /></>;
  }
  return <span className="small"><b className="ev">{e.contract === "TestToken" ? "TST" : "Escrow"}.{e.event}</b> {text}</span>;
}

export const CHAIN_STATUS: Record<string, [string, string]> = {
  None: ["", "Not on chain yet"], Created: ["", "Created · awaiting deposit"], Funded: ["run", "Funded · locked"],
  VerificationPending: ["run", "Locked · verification pending"], Disputed: ["warn", "Locked · disputed"],
  Released: ["ok", "Released to seller"], Refunded: ["bad", "Refunded to buyer"]
};
