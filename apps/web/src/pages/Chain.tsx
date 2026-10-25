import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, when } from "../api.ts";
import { ErrorNote } from "../components/ui.tsx";
import { Addr, EventLine, TxLink, short, tstAmount } from "../components/Chain.tsx";

function roleNames(d: any): Record<string, string> {
  if (!d?.contracts) return {};
  return {
    [d.contracts.TitleEscrow.address]: "TitleEscrow", [d.contracts.TestToken.address]: "TST",
    [d.roles.operator.address]: "operator", [d.roles.oracle.address]: "oracle", [d.roles.feeWallet.address]: "fee wallet"
  };
}

export function ChainPage() {
  const [d, setD] = useState<any>(null);
  const [src, setSrc] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api("/chain").then(setD).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); const t = window.setInterval(load, 5000); return () => window.clearInterval(t); }, [load]);
  useEffect(() => { api("/chain/source").then(setSrc).catch(() => {}); }, []);
  const names = roleNames(d);

  return (
    <main>
      <div className="eyebrow">Web3 escrow</div>
      <h1>Blockchain</h1>
      <p className="muted" style={{ maxWidth: "74ch" }}>
        The buyer deposits <b>TST</b>, a mock ERC-20 test token with no monetary value, into the <b>TitleEscrow</b> smart contract.
        The contract releases it to the seller only on a verified-clean verdict and refunds the buyer on a qualifying defect such as an undisclosed mortgage.
        It keeps the deposit locked when the evidence is inconclusive. Every verdict must be signed by the verification oracle (EIP-712), name the escrow and search, be unexpired, and carry an unused nonce.
      </p>
      <ErrorNote error={error ?? d?.error ?? null} />
      {d && d.enabled === false && <div className="card"><h2>Blockchain escrow is switched off</h2><p className="muted">Set CHAIN_MODE=embedded in .env and restart.</p></div>}
      {d?.network && (
        <>
          <div className="grid3">
            <section className="card stat"><span className="eyebrow">Network</span><b>{d.network.name}</b><span className="small muted">Chain ID {d.network.chainId} · {d.network.mode === "embedded" ? "local EVM test chain" : "public EVM testnet"}</span></section>
            <section className="card stat"><span className="eyebrow">Latest block</span><b className="mono">#{d.network.latestBlock.toLocaleString("en-IN")}</b><span className="small muted">RPC {d.network.rpcUrl}</span></section>
            <section className="card stat"><span className="eyebrow">Locked in escrow now</span><b className="mono">{tstAmount(d.contracts.TitleEscrow.totalLocked)}</b><span className="small muted">TST supply {tstAmount(d.contracts.TestToken.totalSupply)}</span></section>
          </div>

          <div className="split">
            <div className="stack">
              <section className="card">
                <h2>Contracts</h2>
                <dl className="kv small">
                  <dt>TitleEscrow</dt><dd><Addr a={d.contracts.TitleEscrow.address} explorer={d.network.explorer} /></dd>
                  <dt>Deployed</dt><dd>block #{d.contracts.TitleEscrow.deployBlock} · {d.contracts.TitleEscrow.deployTx && <TxLink hash={d.contracts.TitleEscrow.deployTx.trim()} explorer={d.network.explorer} />}</dd>
                  <dt>TST (test token)</dt><dd><Addr a={d.contracts.TestToken.address} explorer={d.network.explorer} /></dd>
                  <dt>Deployed</dt><dd>block #{d.contracts.TestToken.deployBlock} · {d.contracts.TestToken.deployTx && <TxLink hash={d.contracts.TestToken.deployTx.trim()} explorer={d.network.explorer} />}</dd>
                  <dt>Compiler</dt><dd>{d.compiler.compiler.split("+")[0]} · EVM {d.compiler.settings.evmVersion} · optimizer on</dd>
                </dl>
              </section>
              <section className="card">
                <h2>Who can do what</h2>
                <dl className="kv small">
                  <dt>Operator</dt><dd><span className="mono">{short(d.roles.operator.address)}</span><div className="hint">{d.roles.operator.does}</div></dd>
                  <dt>Verification oracle</dt><dd><span className="mono">{short(d.roles.oracle.address)}</span><div className="hint">{d.roles.oracle.does}</div></dd>
                  <dt>Fee wallet</dt><dd><span className="mono">{short(d.roles.feeWallet.address)}</span><div className="hint">{d.roles.feeWallet.does}</div></dd>
                  <dt>Anyone</dt><dd><div className="hint">Can submit a signed verdict (only the oracle's signature counts), and can call refundAfterDeadline() after the deadline, which only ever returns the deposit to the buyer.</div></dd>
                </dl>
              </section>
              <section className="card">
                <h2>Contract rules</h2>
                <ol className="rules small">
                  <li><b>settle()</b> accepts a verdict only if the oracle signed it (EIP-712), it names this escrow and search, it hasn't expired and its nonce is unused. Otherwise it reverts: <span className="mono">UnauthorizedSigner</span>, <span className="mono">WrongEscrowOrSearch</span>, <span className="mono">AttestationExpired</span>, <span className="mono">NonceAlreadyUsed</span>.</li>
                  <li><b>Verified clean</b> releases to the seller (less the fee), but only with a score of 90+ or after an advocate resolved a dispute (<span className="mono">TitleNotClear</span> otherwise).</li>
                  <li><b>Qualifying defect</b> refunds the full deposit to the buyer. <b>Inconclusive</b> moves nothing and marks the escrow disputed.</li>
                  <li>A settled escrow can't be settled again. Tokens can only reach the depositing buyer, the seller fixed at creation, or the fee wallet. Reentrancy guarded, checks-effects-interactions.</li>
                </ol>
              </section>
            </div>

            <div className="stack">
              <section className="card">
                <div className="card-head"><h2>Transactions</h2><span className="small muted">updates every 5 s</span></div>
                {!d.transactions.length ? <div className="empty">No transactions yet.</div> : (
                  <div className="tablewrap"><table>
                    <thead><tr><th className="num">Block</th><th>Tx</th><th>What happened</th><th>From</th><th className="num">Gas</th><th>Time</th></tr></thead>
                    <tbody>{d.transactions.map((t: any) => (
                      <tr key={t.tx_hash}>
                        <td className="num mono">{t.block_number}</td>
                        <td><TxLink hash={t.tx_hash.trim()} explorer={d.network.explorer} /></td>
                        <td className="small">{t.label}<div className="hint mono">{t.contract === "TestToken" ? "TST" : t.contract}.{t.method}()</div></td>
                        <td><Addr a={t.from_addr} names={names} /></td>
                        <td className="num small">{Number(t.gas_used).toLocaleString("en-IN")}</td>
                        <td className="small">{new Date(t.created_at).toLocaleTimeString("en-IN")}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                )}
              </section>
              {src && (
                <section className="card">
                  <h2>Source code</h2>
                  <p className="small muted">Compiled with {src.compiler.split("+")[0]}. The deployed bytecode is built from exactly these files, and a test checks that.</p>
                  {src.files.map((f: any) => (
                    <details key={f.file} className="src">
                      <summary className="mono small">{f.file}</summary>
                      <pre className="code">{f.source}</pre>
                    </details>
                  ))}
                </section>
              )}
            </div>
          </div>
        </>
      )}
    </main>
  );
}

export function ChainTxPage() {
  const { hash } = useParams();
  const [t, setT] = useState<any>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api(`/chain/tx/${hash}`).then(setT).catch((e) => setError(e.message));
    api("/chain").then((d) => setNames(roleNames(d))).catch(() => {});
  }, [hash]);
  return (
    <main>
      <div className="eyebrow"><Link to="/chain">Blockchain</Link> / transaction</div>
      <h1 className="mono" style={{ fontSize: "1.1rem", overflowWrap: "anywhere" }}>{hash}</h1>
      <ErrorNote error={error} />
      {t && (
        <div className="split">
          <section className="card">
            <div className="card-head"><h2>{t.label ?? "Transaction"}</h2><span className={`pill ${t.status === "Success" ? "ok" : t.status === "Reverted" ? "bad" : ""}`}>{t.status}</span></div>
            <dl className="kv small">
              <dt>Block</dt><dd className="mono">#{t.blockNumber}</dd>
              <dt>Time</dt><dd>{when(t.timestamp)}</dd>
              <dt>From</dt><dd><Addr a={t.from} names={names} /></dd>
              <dt>To</dt><dd><Addr a={t.to} names={names} /></dd>
              <dt>Function</dt><dd className="mono">{t.contract === "TestToken" ? "TST" : t.contract}.{t.method}()</dd>
              <dt>Gas used</dt><dd>{Number(t.gasUsed).toLocaleString("en-IN")}{t.gasPriceGwei != null && ` at ${t.gasPriceGwei} gwei`}</dd>
              <dt>Nonce</dt><dd>{t.nonce}</dd>
              {t.escrowId && <><dt>Escrow</dt><dd><Link to={`/escrow/${t.escrowId}`}>Open the escrow</Link></dd></>}
            </dl>
          </section>
          <div className="stack">
            <section className="card">
              <h2>Events emitted</h2>
              {!t.events?.length ? <div className="empty">No events.</div> : <ul className="events">{t.events.map((e: any, i: number) => <li key={i}><EventLine e={e} names={names} /></li>)}</ul>}
            </section>
            {t.args && (
              <section className="card">
                <h2>Arguments</h2>
                <pre className="code">{JSON.stringify(t.args, null, 2)}</pre>
              </section>
            )}
            {t.input && (
              <section className="card">
                <h2>Raw input data</h2>
                <pre className="code" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{t.input.length > 1400 ? `${t.input.slice(0, 1400)}… (${((t.input.length - 2) / 2).toLocaleString("en-IN")} bytes)` : t.input}</pre>
              </section>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
