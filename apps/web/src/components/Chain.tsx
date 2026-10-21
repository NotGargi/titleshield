import { Link } from "react-router-dom";

/** Small pieces for showing on-chain data: addresses, transaction hashes, tINR amounts and decoded events. */

export const short = (h: string | null | undefined, n = 6) => (h ? `${h.slice(0, n + 2)}…${h.slice(-4)}` : "—");
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x" + "00".repeat(32);

/** tINR has 2 decimals: on-chain integers are paise. */
export const tinr = (paise: string | number | null | undefined) =>
  paise == null ? "—" : `${(Number(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })} tINR`;
export const tinrRupees = (rupees: number | null | undefined) => (rupees == null ? "—" : `${Number(rupees).toLocaleString("en-IN", { maximumFractionDigits: 2 })} tINR`);

export function TxLink({ hash }: { hash: string }) {
  return <Link className="mono small" to={`/chain/tx/${hash}`} title={hash}>{short(hash, 8)}</Link>;
}

export function Addr({ a, names }: { a: string | null | undefined; names?: Record<string, string> }) {
  if (!a) return <span className="muted">—</span>;
  if (a.toLowerCase() === ZERO_ADDR) return <span className="small muted">0x0 (mint / burn)</span>;
  const label = names && Object.entries(names).find(([addr]) => addr.toLowerCase() === a.toLowerCase())?.[1];
  return <span className="mono small" title={a}>{short(a)}{label && <span className="addr-tag">{label}</span>}</span>;
}

export const isZeroHash = (h: string | null | undefined) => !h || h === ZERO_HASH;

/** One decoded event as a readable line. */
export function EventLine({ e, names }: { e: { contract: string; event: string; args: Record<string, any> }; names?: Record<string, string> }) {
  const a = e.args;
  let text: React.ReactNode = Object.entries(a).map(([k, v]) => `${k}: ${String(v).length > 20 ? short(String(v)) : v}`).join(" · ");
  if (e.event === "Opened") text = <>escrow opened for {tinr(a.amount)} (fee {tinr(a.fee)}) · buyer <Addr a={a.buyer} names={names} /> · seller <Addr a={a.seller} names={names} /></>;
  if (e.event === "Funded") text = <>{tinr(a.amount)} locked in the contract</>;
  if (e.event === "HeldForReview") text = <>held for advocate review · title score {a.score}</>;
  if (e.event === "Released") text = <>{tinr(a.toSeller)} unlocked to seller <Addr a={a.seller} names={names} /> · fee {tinr(a.fee)} · title score {a.score}</>;
  if (e.event === "Refunded") text = <>{tinr(a.amount)} returned to buyer <Addr a={a.buyer} names={names} /> · {a.reason}</>;
  if (e.event === "Redeemed") text = <>{tinr(a.value)} redeemed: the bank paid it out in rupees</>;
  if (e.event === "MinterSet") text = <><Addr a={a.minter} names={names} /> may mint: {String(a.allowed)}</>;
  if (e.event === "Transfer") {
    text = a.from?.toLowerCase() === ZERO_ADDR ? <>minted {tinr(a.value)} to <Addr a={a.to} names={names} /></>
      : a.to?.toLowerCase() === ZERO_ADDR ? <>burned {tinr(a.value)} from <Addr a={a.from} names={names} /></>
      : <>{tinr(a.value)} <Addr a={a.from} names={names} /> → <Addr a={a.to} names={names} /></>;
  }
  return <span className="small"><b className="ev">{e.contract === "TitleShieldINR" ? "tINR" : "Escrow"}.{e.event}</b> {text}</span>;
}

export const CHAIN_STATUS: Record<string, [string, string]> = {
  None: ["", "Not on chain yet"], Open: ["", "Open · awaiting deposit"], Funded: ["run", "Funded · locked"], OnHold: ["warn", "Locked · advocate review"],
  Released: ["ok", "Released to seller"], Refunded: ["bad", "Refunded to buyer"]
};
