import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fileUrl, inr, streamEvents, when } from "../api.ts";
import { ErrorNote, StatusPill } from "../components/ui.tsx";
import { RecordsUpload, uploadDocs, type PendingDoc } from "../components/RecordsUpload.tsx";
import { Addr, CHAIN_STATUS, EventLine, OUTCOME_LABEL, TxLink, isZeroHash, short, tstAmount } from "../components/Chain.tsx";
import { useApp } from "../App.tsx";

const STEPS = [
  ["ESCROW_CREATED", "Agreement e-signed by buyer and seller; escrow created in the TitleEscrow contract"],
  ["FUNDS_LOCKED", "Buyer deposits test tokens; the contract locks them"],
  ["VERIFICATION_IN_PROGRESS", "TinyFish Search + Fetch and the records are verified"],
  ["SETTLEMENT", "Signed verdict: contract releases, refunds, or keeps the tokens locked"]
] as const;

/** The escrow as the TitleEscrow smart contract holds it (read live from the chain). */
function SmartContractCard({ c, escrowId, onChange }: { c: any; escrowId: string; onChange: () => void }) {
  const [check, setCheck] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState("");
  if (!c || c.enabled === false) return null;
  const st = CHAIN_STATUS[c.status ?? "None"] ?? ["", c.status];
  const explorer = c.network?.explorer ?? null;
  const names: Record<string, string> = c.wallets ? Object.fromEntries([
    [c.wallets.buyer.address ?? "", "buyer"], [c.wallets.seller.address, "seller"], [c.wallets.escrowContract.address, "TitleEscrow"],
    [c.wallets.oracle.address, "oracle"], [c.wallets.operator.address, "operator"]
  ].filter(([a]) => a)) : {};
  const evs = (c.transactions ?? []).flatMap((t: any) => t.events ?? []);
  const released = evs.filter((e: any) => e.event === "Released").reduce((n: number, e: any) => n + Number(e.args.toSeller) / 100, 0);
  const refunded = evs.filter((e: any) => e.event === "Refunded").reduce((n: number, e: any) => n + Number(e.args.amount) / 100, 0);
  const verdicts = (c.attestations ?? []).filter((a: any) => a.kind === "VERDICT");
  const canTest = ["VerificationPending", "Disputed", "Released", "Refunded"].includes(c.status);

  async function runCheck(kind: string) {
    setBusy(kind);
    try { const r = await api(`/escrow/${escrowId}/chain/security-check`, { body: { kind } }); setCheck((x) => ({ ...x, [kind]: r })); onChange(); }
    catch (err) { setCheck((x) => ({ ...x, [kind]: { rejected: null, reason: (err as Error).message } })); }
    finally { setBusy(""); }
  }

  return (
    <section className="card contract-card">
      <div className="card-head"><h2>Smart contract escrow</h2><span className={`pill ${st[0]}`}>{st[0] === "run" && <span className="dot pulse" />}{st[1]}</span></div>
      {c.error && <p className="small muted">Blockchain not reachable: {c.error}</p>}
      {!c.onChain && !c.error && <p className="small muted">The escrow is created on-chain as soon as both parties have e-signed.</p>}
      {c.onChain && (
        <>
          <p className="small muted">The buyer's deposit is held by the TitleEscrow contract in TST, a test token with no monetary value. The contract releases or refunds it only on a verdict signed by the verification oracle, and keeps it locked when the evidence is inconclusive.</p>
          <div className="chain-flow">
            <div className={refunded ? "got" : ""}><span className="eyebrow">Buyer wallet</span><Addr a={c.wallets.buyer.address ?? c.demoBuyerWallet} explorer={explorer} />
              {refunded ? <><b className="mono">+{tstAmount(refunded)}</b><span className="hint">refunded by the contract</span></> : <b className="mono">{c.wallets.buyer.address ? tstAmount(c.wallets.buyer.tokens) : "no deposit yet"}</b>}</div>
            <div className="lock"><span className="eyebrow">Locked in contract</span><Addr a={c.contract} explorer={explorer} /><b className="mono">{tstAmount(c.wallets.escrowContract.tokens)}</b>
              <span className="hint">{["Funded", "VerificationPending", "Disputed"].includes(c.status) ? "only an oracle-signed verdict can move it" : c.status === "Created" ? "waiting for the buyer's deposit" : "settled"}</span></div>
            <div className={released ? "got" : ""}><span className="eyebrow">Seller wallet</span><Addr a={c.wallets.seller.address} explorer={explorer} />
              {released ? <><b className="mono">+{tstAmount(released)}</b><span className="hint">released by the contract</span></> : <b className="mono">{tstAmount(c.wallets.seller.tokens)}</b>}</div>
          </div>
          <dl className="kv small">
            <dt>Escrow ID</dt><dd className="mono" title={c.escrowKey}>{short(c.escrowKey, 10)}</dd>
            <dt>Bound to search</dt><dd className="mono" title={c.searchKey}>{short(c.searchKey, 10)}</dd>
            <dt>Deposit · fee</dt><dd>{tstAmount(c.amount)} · {tstAmount(c.fee)} (fee only on release)</dd>
            <dt>Agreement hash</dt><dd className="hash">{c.agreementHash}</dd>
            {!isZeroHash(c.evidenceHash) && <><dt>Evidence hash</dt><dd className="hash">{c.evidenceHash}</dd></>}
            {c.deadline && <><dt>Buyer-protection deadline</dt><dd>{when(c.deadline)} (after this, an unsettled deposit can only go back to the buyer)</dd></>}
          </dl>

          {verdicts.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <h3>Signed verdicts</h3>
              {verdicts.map((v: any, i: number) => (
                <div key={i} className="attest">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <b className="small">{OUTCOME_LABEL[v.outcome]}{v.payload.advocateReviewed ? " · advocate reviewed" : ""} · score {v.payload.score}</b>
                    <span className={`pill ${v.status === "ACCEPTED" ? "ok" : v.status === "REJECTED" ? "bad" : ""}`}>{v.status === "ACCEPTED" ? "Accepted by contract" : v.status}</span>
                  </div>
                  <div className="hint mono">signed by oracle {short(v.signer)} · nonce {short(v.payload.nonce)} · expires {new Date(v.payload.expiresAt * 1000).toLocaleTimeString("en-IN")}{v.tx_hash ? " · " : ""}{v.tx_hash && <TxLink hash={v.tx_hash.trim()} explorer={explorer} />}</div>
                </div>
              ))}
            </div>
          )}

          {c.transactions?.length > 0 && (
            <details className="src" open>
              <summary className="small">Blockchain transactions ({c.transactions.length})</summary>
              <ol className="chain-txs" style={{ padding: 8 }}>
                {c.transactions.map((t: any) => (
                  <li key={t.tx_hash}>
                    <div className="row" style={{ justifyContent: "space-between" }}><b className="small">{t.label}</b><span className="small muted">block #{t.block_number} · <TxLink hash={t.tx_hash.trim()} explorer={explorer} /></span></div>
                    {(t.events ?? []).filter((e: any) => e.contract === "TitleEscrow").map((e: any, i: number) => <div key={i}><EventLine e={e} names={names} /></div>)}
                  </li>
                ))}
              </ol>
            </details>
          )}

          {canTest && (
            <div className="stack" style={{ gap: 6 }}>
              <h3>Security checks</h3>
              <p className="hint">Each button asks the contract to accept a bad verdict. The contract should refuse every one.</p>
              <div className="row">
                {[["FORGED_SIGNER", "Forged signer"], ["REPLAY", "Replay last verdict"], ["EXPIRED", "Expired verdict"], ["WRONG_ESCROW", "Verdict for another search"]].map(([k, label]) => (
                  <button key={k} className="small-btn" disabled={!!busy || (k === "REPLAY" && !verdicts.some((v: any) => v.status === "ACCEPTED"))} onClick={() => runCheck(k)}>{busy === k ? "Trying…" : label}</button>
                ))}
              </div>
              {Object.entries(check).map(([k, r]: any) => (
                <div key={k} className={`small ${r.rejected ? "ok-text" : "bad-text"}`}>{r.rejected ? "✓ Refused" : r.rejected === false ? "✗ Accepted" : "Error"} · {k.replace(/_/g, " ").toLowerCase()}: <span className="mono">{String(r.reason).replace(/^Smart contract refused: /, "")}</span></div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

const ETH = () => (typeof window !== "undefined" ? (window as any).ethereum : null);

/** Deposit: test tokens into the contract (demo wallet or the buyer's own MetaMask), or the bank rail when the contract is off. */
function DepositCard({ e, chain, signed, onDone, setError }: { e: any; chain: any; signed: boolean; onDone: () => void; setError: (s: string | null) => void }) {
  const { meta } = useApp();
  const [busy, setBusy] = useState("");
  const [step, setStep] = useState("");
  const chainOn = meta?.chain != null;
  const waiting = e.escrow_state === "AWAITING_DEPOSIT";

  async function pay(mode: string) {
    setBusy(mode); setError(null);
    try { await api(`/escrow/${e.escrow_id}/deposit`, { body: { mode } }); setTimeout(onDone, 400); } catch (err) { setError((err as Error).message); } finally { setBusy(""); }
  }

  async function metamask() {
    const eth = ETH();
    setBusy("mm"); setError(null);
    try {
      const net = (await api("/chain")).network;
      if (!net?.walletRpcUrl) throw new Error("MetaMask needs a public test network. Set CHAIN_MODE=rpc with a testnet (see README), or use the demo wallet.");
      if (net.mode === "embedded" && !/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) throw new Error("This hosted demo runs its own private chain, so MetaMask can't reach it. Use the demo wallet, or deploy to a public testnet.");
      setStep("Connecting MetaMask…");
      const [account] = await eth.request({ method: "eth_requestAccounts" });
      const hex = "0x" + Number(net.chainId).toString(16);
      try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
      catch (sw: any) {
        if (sw?.code !== 4902) throw sw;
        await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: net.name, rpcUrls: [net.walletRpcUrl], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, ...(net.explorer ? { blockExplorerUrls: [net.explorer] } : {}) }] });
      }
      setStep("Getting test tokens from the faucet…");
      await api(`/escrow/${e.escrow_id}/chain/faucet`, { body: { address: account } });
      const { BrowserProvider, Contract } = await import("ethers");
      const signer = await new BrowserProvider(eth).getSigner();
      const units = BigInt(Math.round(Number(e.advance_deposit_amount_inr) * 100));
      setStep("Approve in MetaMask (1 of 2)…");
      await (await new Contract(chain.token, ["function approve(address spender, uint256 value) returns (bool)"], signer).approve(chain.contract, units)).wait();
      setStep("Deposit in MetaMask (2 of 2)…");
      await (await new Contract(chain.contract, ["function deposit(bytes32 escrowId)"], signer).deposit(chain.escrowKey)).wait();
      setStep("Checking the contract…");
      await api(`/escrow/${e.escrow_id}/chain/confirm-deposit`, { body: {} });
      setStep(""); onDone();
    } catch (err: any) { setError(err?.shortMessage ?? err?.message ?? String(err)); setStep(""); }
    finally { setBusy(""); }
  }

  if (!chainOn) {
    return (
      <section className="card">
        <h2>3 · Pay the advance</h2>
        <div className="va">
          <span>Beneficiary: TitleShield Escrow — {e.escrow_reference}</span>
          <span>Account: {e.virtual_account_number}</span>
          <span>IFSC: {e.virtual_account_ifsc}</span>
          <span>Amount: {inr(e.advance_deposit_amount_inr - e.amount_deposited_inr)}</span>
        </div>
        {waiting ? (
          <div className="row">{["UPI", "IMPS", "NEFT", "RTGS"].map((m) => <button key={m} className={m === "RTGS" ? "primary" : ""} disabled={!signed || !!busy} onClick={() => pay(m)}>{busy === m ? "Paying…" : `Pay by ${m}`}</button>)}</div>
        ) : <p className="small">Received · UTR <span className="mono">{e.bank_utr_deposit}</span></p>}
      </section>
    );
  }

  return (
    <section className="card">
      <h2>3 · Deposit into the smart contract</h2>
      <div className="va">
        <span>Contract: TitleEscrow {chain?.contract ? short(chain.contract) : ""}</span>
        <span>Asset: TST (test token, no monetary value)</span>
        <span>Amount: {tstAmount(Number(e.advance_deposit_amount_inr))}</span>
      </div>
      {waiting ? (
        <>
          <p className="small muted">The buyer approves the contract and calls deposit(). The tokens leave the buyer's wallet and stay locked until an oracle-signed verdict. The title search starts as soon as the contract shows the deposit.</p>
          <div className="row">
            <button className="primary" disabled={!signed || !!busy || !chain?.onChain} onClick={() => pay("CHAIN")}>{busy === "CHAIN" ? "Depositing…" : "Deposit from the buyer's demo wallet"}</button>
            {ETH() && <button disabled={!signed || !!busy || !chain?.onChain} onClick={metamask}>{busy === "mm" ? "Waiting for MetaMask…" : "Deposit with MetaMask"}</button>}
          </div>
          {step && <p className="small">{step}</p>}
          {!signed && <p className="hint">Both parties must sign first.</p>}
        </>
      ) : <p className="small">Deposited from <span className="mono">{short(e.buyer_wallet ?? chain?.wallets?.buyer?.address)}</span> · locked in the contract</p>}
    </section>
  );
}

function ESign({ escrowId, party, signedAt, onDone }: { escrowId: string; party: "buyer" | "seller"; signedAt: string | null; onDone: () => void }) {
  const [last4, setLast4] = useState("");
  const [session, setSession] = useState<any>(null);
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (signedAt) return <div className="row"><span className="pill ok">Signed</span><span className="small muted">{party} · {when(signedAt)}</span></div>;
  return (
    <div className="stack">
      {!session ? (
        <form className="row" style={{ flexWrap: "nowrap" }} onSubmit={async (e) => { e.preventDefault(); setError(null); try { setSession(await api(`/escrow/${escrowId}/esign/${party}/start`, { body: { aadhaarLast4: last4 } })); } catch (x) { setError((x as Error).message); } }}>
          <input id={`${party}Aadhaar`} placeholder="Last 4 digits of Aadhaar" inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ""))} />
          <button type="submit" disabled={last4.length !== 4}>Send OTP</button>
        </form>
      ) : (
        <form className="stack" onSubmit={async (e) => { e.preventDefault(); setError(null); try { await api(`/escrow/${escrowId}/esign/${party}/verify`, { body: { esignId: session.esignId, otp } }); onDone(); } catch (x) { setError((x as Error).message); } }}>
          <p className="small muted">OTP sent to the mobile linked with {session.maskedAadhaar}.{session.sandboxOtp && <> Sandbox OTP: <b className="mono">{session.sandboxOtp}</b></>}</p>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input id={`${party}Otp`} placeholder="6-digit OTP" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))} />
            <button className="primary" type="submit" disabled={otp.length !== 6}>Sign</button>
          </div>
        </form>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

export function EscrowPage() {
  const { id } = useParams();
  const [e, setE] = useState<any>(null);
  const [stmt, setStmt] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [docs, setDocs] = useState<PendingDoc[]>([]);
  const [uploaded, setUploaded] = useState<any[]>([]);
  const [chain, setChain] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      const x = await api(`/escrow/${id}`);
      setE(x);
      setStmt(await api(`/escrow/${id}/bank-statement`));
      api(`/escrow/${id}/chain`).then(setChain).catch(() => setChain(null));
      setUploaded((await api(`/title-search/${x.search_id}`)).documents ?? []);
    } catch (err) { setError((err as Error).message); }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!e?.search_id) return;
    return streamEvents(e.search_id, (name) => { if (name.startsWith("escrow") || name === "chain_tx" || name === "title_clearance_result" || name === "advocate_review_opened") load(); });
  }, [e?.search_id, load]);

  const { meta } = useApp();
  const chainOn = meta?.chain != null;

  if (!e) return <main>{error ? <div className="form-error">{error}</div> : <div className="empty">Loading escrow…</div>}</main>;
  const signed = !!(e.buyer_signed_at && e.seller_signed_at);
  const stateIdx = { AWAITING_DEPOSIT: signed ? 1 : 0, FUNDS_LOCKED: 1, VERIFICATION_IN_PROGRESS: 2, RELEASED_TO_SELLER: 3, REFUNDED_TO_BUYER: 3, DISPUTE_HOLD: 3 }[e.escrow_state as string] ?? 0;
  const final = ["RELEASED_TO_SELLER", "REFUNDED_TO_BUYER", "DISPUTE_HOLD"].includes(e.escrow_state);

  return (
    <main>
      <div className="run-head">
        <div className="stack" style={{ gap: 4 }}>
          <div className="eyebrow">Escrow {e.escrow_reference}</div>
          <h1>{e.survey_number ? `Survey ${e.survey_number}, ` : ""}{e.village_name}</h1>
          <p className="muted">{e.address_text ? `${e.address_text} · ` : ""}{[e.taluk_name, e.district_name, e.state_code].filter(Boolean).join(", ")} · {e.buyer_name} → {e.seller_name}</p>
        </div>
        <StatusPill status={e.escrow_state} />
      </div>
      <ErrorNote error={error} />

      <div className="split">
        <div className="stack">
          <section className="card">
            <h2>Escrow state</h2>
            <ol className="stepper">
              {STEPS.map(([code, label], i) => {
                let cls = i < stateIdx || (i === 0 && signed) ? "done" : i === stateIdx ? "now" : "";
                let text: string = label, c: string = code;
                if (i === 3 && final) {
                  cls = e.escrow_state === "RELEASED_TO_SELLER" ? "good" : e.escrow_state === "REFUNDED_TO_BUYER" ? "bad" : "hold";
                  c = e.escrow_state;
                  text = e.escrow_state === "RELEASED_TO_SELLER" ? `Contract released ${chainOn ? tstAmount(Number(e.settlement_amount_inr)) : inr(e.settlement_amount_inr)} to ${e.seller_name}` : e.escrow_state === "REFUNDED_TO_BUYER" ? `Contract refunded ${chainOn ? tstAmount(Number(e.settlement_amount_inr)) : inr(e.settlement_amount_inr)} to ${e.buyer_name}` : "Inconclusive: tokens stay locked until an advocate decides";
                }
                return <li key={code} className={cls}><span>{text}<span className="code">{c}</span></span></li>;
              })}
            </ol>
            <div className="row">
              <Link className="btn" to={`/search/${e.search_id}`}>{e.search_status === "QUEUED" ? "Verification (waiting for deposit)" : "Open live verification"}</Link>
              <a className="btn" href={fileUrl(`/api/v1/escrow/${id}/agreement.pdf`)} target="_blank" rel="noreferrer">Agreement PDF</a>
            </div>
          </section>

          <section className="card">
            <h2>Amounts</h2>
            <div className="money">
              <span>Sale price</span><span className="v">{inr(e.property_total_value_inr)}</span>
              <span>Advance required</span><span className="v">{inr(e.advance_deposit_amount_inr)}</span>
              <span>Deposited</span><span className="v">{inr(e.amount_deposited_inr)}</span>
              <span>Escrow fee (on release)</span><span className="v">{inr(e.platform_escrow_fee_inr)}</span>
              {e.settlement_amount_inr != null && <><span className="tot">Settled</span><span className="v tot">{inr(e.settlement_amount_inr)}</span></>}
            </div>
            <dl className="kv small">
              <dt>Seller account</dt><dd>{e.seller_account_mask} · {e.seller_payout_ifsc} · penny drop: {e.seller_penny_drop_name} ({e.seller_penny_drop_match})</dd>
              <dt>Buyer account</dt><dd>{e.buyer_account_mask} · {e.buyer_refund_ifsc}</dd>
              <dt>Agreement SHA-256</dt><dd className="hash">{e.agreement_sha256}</dd>
            </dl>
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <h2>1 · Sign the tri-party agreement</h2>
            <div className="grid2">
              <div className="stack"><h3>Buyer · {e.buyer_name}</h3><ESign escrowId={id!} party="buyer" signedAt={e.buyer_signed_at} onDone={load} /></div>
              <div className="stack"><h3>Seller · {e.seller_name}</h3><ESign escrowId={id!} party="seller" signedAt={e.seller_signed_at} onDone={load} /></div>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><h2>2 · Add the official records</h2><span className="pill">{uploaded.length ? `${uploaded.length} added` : "recommended"}</span></div>
            {uploaded.length > 0 && <ul className="links">{uploaded.map((d: any) => <li key={d.document_id}><StatusPill status={d.status} /> {d.filename} <span className="muted small">{d.kind}</span></li>)}</ul>}
            {e.escrow_state === "AWAITING_DEPOSIT" ? (
              <>
                <RecordsUpload stateCode={e.state_code} docs={docs} onChange={setDocs} />
                <button disabled={!docs.length || !!busy} onClick={async () => { setBusy("docs"); setError(null); try { await uploadDocs(e.search_id, docs); setDocs([]); await load(); } catch (err) { setError((err as Error).message); } finally { setBusy(""); } }}>{busy === "docs" ? "Uploading…" : "Upload records"}</button>
                <p className="hint">Without the EC and RoR the advance can't be released automatically; an advocate reviews first.</p>
              </>
            ) : !uploaded.length && <p className="small muted">No records were added before the deposit.</p>}
          </section>

          <DepositCard e={e} chain={chain} signed={signed} onDone={load} setError={setError} />

          <SmartContractCard c={chain} escrowId={id!} onChange={load} />

          {!chainOn && <section className="card">
            <div className="card-head"><h2>Trustee bank statement</h2><span className="muted small">{stmt?.status} · balance {inr(stmt?.balance_inr)}</span></div>
            {stmt?.transactions?.length ? (
              <div className="tablewrap"><table>
                <thead><tr><th>UTR</th><th>Type</th><th>To / from</th><th>Mode</th><th className="num">Amount</th></tr></thead>
                <tbody>{stmt.transactions.map((t: any) => (
                  <tr key={t.utr}><td className="mono small">{t.utr}</td><td>{t.kind === "CREDIT" ? "Credit" : t.beneficiary === "PAYEE_A" ? "Payout · seller" : t.beneficiary === "PAYEE_B" ? "Refund · buyer" : "Escrow fee"}</td>
                    <td className="small">{t.counterparty?.name} {t.counterparty?.account}</td><td>{t.mode}</td><td className="num">{inr(t.amount_inr)}</td></tr>
                ))}</tbody>
              </table></div>
            ) : <div className="empty">No transactions yet.</div>}
            <p className="small muted">Payouts execute only with an Ed25519 instruction signed by the verification oracle; the bank checks it against the key registered when this account was opened.</p>
          </section>}

          <section className="card">
            <h2>Audit trail</h2>
            <ul className="timeline">{e.events.map((ev: any, i: number) => (
              <li key={i}><span className="t">{new Date(ev.created_at).toLocaleTimeString("en-IN")}</span>
                <span>{ev.from_state === ev.to_state ? (ev.actor.startsWith("esign") ? `${ev.actor.split(":")[1]} signed` : ev.actor) : `${(ev.from_state ?? "created").toLowerCase().replace(/_/g, " ")} → ${ev.to_state.toLowerCase().replace(/_/g, " ")}`} <span className="muted small">by {ev.actor}</span></span></li>
            ))}</ul>
          </section>
        </div>
      </div>
    </main>
  );
}
