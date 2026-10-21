import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fileUrl, inr, isIndic, streamEvents, when } from "../api.ts";
import { useApp } from "../App.tsx";
import { Gauge, Name, StatusPill, useElapsed } from "../components/ui.tsx";
import { MapView } from "../components/MapView.tsx";
import { RecordsUpload, uploadDocs, type PendingDoc } from "../components/RecordsUpload.tsx";

const ROLES = ["RECORDS", "COURTS", "BANK_NOTICES", "GOVT_NOTICES"] as const;
const ROLE_TITLE: Record<string, string> = {
  RECORDS: "Official records (EC · RoR · deeds)",
  COURTS: "Court records",
  BANK_NOTICES: "Bank notices (SARFAESI)",
  GOVT_NOTICES: "Government notifications & RERA"
};
const ROLE_SOURCE: Record<string, string> = {
  RECORDS: "Documents added by the owner",
  COURTS: "TinyFish Search + Fetch · Indian Kanoon, eCourts, High Court",
  BANK_NOTICES: "TinyFish Search + Fetch · bank and auction notices",
  GOVT_NOTICES: "TinyFish Search + Fetch · gov.in, e-Gazette, RERA"
};

interface AgentView { status: string; steps: Array<{ t: number; text: string; results?: Array<{ title: string; url: string }>; waiting?: boolean }>; counts?: any }

function StrengthPill({ s }: { s: string }) {
  return <span className={`pill ${s === "STRONG" ? "bad" : s === "MEDIUM" ? "warn" : ""}`}>{s === "STRONG" ? "Confirmed match" : s === "MEDIUM" ? "Possible match" : "Not counted"}</span>;
}

function Findings({ list }: { list: any[] }) {
  const shown = [...list].sort((a, b) => ({ STRONG: 0, MEDIUM: 1, WEAK: 2 } as any)[a.strength] - ({ STRONG: 0, MEDIUM: 1, WEAK: 2 } as any)[b.strength]);
  if (!shown.length) return null;
  return (
    <ul className="findings">
      {shown.map((f, i) => (
        <li key={i} className={`finding ${f.strength}`}>
          <div className="row" style={{ justifyContent: "space-between" }}><a href={f.url} target="_blank" rel="noreferrer"><b>{f.title}</b></a><StrengthPill s={f.strength} /></div>
          {f.snippet && <p className="small">{f.snippet}</p>}
          <p className="hint">{f.reasons.join(" · ")}</p>
        </li>
      ))}
    </ul>
  );
}

function SearchLog({ log }: { log: any[] }) {
  if (!log?.length) return null;
  return (
    <details className="searchlog">
      <summary>{log.length} search{log.length > 1 ? "es" : ""} · {log.reduce((n, s) => n + s.results, 0)} results</summary>
      {log.map((s, i) => (
        <div key={i} className="stack" style={{ gap: 4, marginTop: 8 }}>
          <div className="mono small">“{s.query}”{s.domains.length ? <span className="muted"> on {s.domains.join(", ")}</span> : null}{s.cached ? <span className="muted"> · cached</span> : null}</div>
          {s.urls.length ? <ul className="links">{s.urls.slice(0, 6).map((u: any) => <li key={u.url}><a href={u.url} target="_blank" rel="noreferrer">{u.title || u.url}</a></li>)}</ul> : <div className="hint">No results</div>}
        </div>
      ))}
    </details>
  );
}

export function SearchPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user } = useApp();
  const [rec, setRec] = useState<any>(null);
  const [agents, setAgents] = useState<Record<string, AgentView>>({});
  const [location, setLocation] = useState<any>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  const [ocr, setOcr] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [feed, setFeed] = useState<Array<{ at: string; text: string; kind?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [docs, setDocs] = useState<PendingDoc[]>([]);
  const refreshTimer = useRef<number | null>(null);

  const load = useCallback(() => api(`/title-search/${id}`).then(setRec).catch((e) => setError(e.message)), [id]);
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(load, 250);
  }, [load]);

  useEffect(() => {
    load();
    setAgents({}); setFeed([]); setOcr(null); setResult(null); setStartedAt(null); setStoppedAt(null); setLocation(null);
    const close = streamEvents(id!, (name, d) => {
      const push = (text: string, kind?: string) => setFeed((f) => [...f, { at: d.at, text, kind }]);
      switch (name) {
        case "agent_spawned": setStartedAt((s) => s ?? d.at); break;
        case "location_resolved": setLocation(d); break;
        case "tinyfish_started":
        case "tinyfish_progress":
        case "tinyfish_agent_completed":
          setAgents((a) => {
            const cur: AgentView = a[d.role] ?? { status: "STREAMING", steps: [] };
            const next = { ...cur, steps: [...cur.steps] };
            if (name === "tinyfish_progress") next.steps.push({ t: (d.elapsedMs ?? 0) / 1000, text: d.step, results: d.results, waiting: d.waiting });
            if (name === "tinyfish_agent_completed") { next.status = d.status; next.counts = d.counts; }
            return { ...a, [d.role]: next };
          });
          if (name === "tinyfish_agent_completed") refreshSoon();
          break;
        case "portal_retry_scheduled": push(`Retrying ${d.portals.join(", ")} in ${Math.round(d.delayMs / 1000)} s`); break;
        case "ocr_completed": setOcr(d); break;
        case "title_scored": refreshSoon(); break;
        case "advocate_review_opened": setStoppedAt((s) => s ?? d.at); push(`Sent to an empanelled advocate`, "warn"); refreshSoon(); break;
        case "advocate_decision": push(`Advocate ${d.decision === "APPROVE" ? "approved" : "rejected"}: ${d.notes}`); refreshSoon(); break;
        case "title_clearance_result": setStoppedAt((s) => s ?? d.at); setResult(d); refreshSoon(); break;
        case "search_failed": setStoppedAt((s) => s ?? d.at); setError(d.reason); refreshSoon(); break;
        case "escrow_deposit": push(`Advance credited: ${inr(d.amountINR)} by ${d.mode} (UTR ${d.utr})`); break;
        case "escrow_state": push(`Escrow ${String(d.from ?? "").toLowerCase().replace(/_/g, " ")} → ${d.to.toLowerCase().replace(/_/g, " ")}`); refreshSoon(); break;
        case "escrow_settled": refreshSoon(); break;
        case "chain_tx": push(`On-chain: ${d.label} · block #${d.block} · tx ${String(d.hash).slice(0, 10)}…`, /refund/i.test(d.label) ? "bad" : undefined); break;
        case "escrow_payout_confirmed": push(`Bank paid ${inr(d.amountINR)} to ${d.beneficiary === "PAYEE_A" ? "seller" : d.beneficiary === "PAYEE_B" ? "buyer" : "fee account"} by ${d.mode} (UTR ${d.utr})`); break;
        case "monitor_started": push(`Monitoring bank notices, court records and notifications every ${d.intervalMinutes} min until ${d.until}`); refreshSoon(); break;
        case "monitor_check_completed": push(`Monitoring check: ${d.alerts ? `${d.alerts} new item${d.alerts > 1 ? "s" : ""}` : "no change"}`, d.alerts ? "bad" : undefined); refreshSoon(); break;
        case "monitor_alert": push(`ALERT ${String(d.kind).replace(/_/g, " ").toLowerCase()}: ${d.title}`, "bad"); break;
      }
    });
    return () => { close(); if (refreshTimer.current) window.clearTimeout(refreshTimer.current); };
  }, [id, load, refreshSoon]);

  const elapsed = useElapsed(startedAt, stoppedAt);
  const a = rec?.assessment;
  const loc = location?.location ?? rec?.location_json;
  const portals = location?.portals ?? [];
  const running = rec && ["RUNNING_TINYFISH", "OCR_PARSING", "SCORING"].includes(rec.status);
  const runsByRole = useMemo(() => {
    const m: Record<string, any> = {};
    for (const r of rec?.agentRuns ?? []) m[r.agent_role] = r; // latest wins (ordered by start)
    return m;
  }, [rec]);
  const translit = useMemo(() => new Map<string, string>((ocr?.transliterations ?? []).map((t: any) => [t.original, t.latin])), [ocr]);

  async function action(label: string, fn: () => Promise<any>) {
    setBusy(label); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }

  async function startWithDocs() {
    await action("start", async () => {
      if (docs.length) await uploadDocs(id!, docs);
      await api(`/title-search/${id}/start`, { body: {} });
      setDocs([]);
    });
  }

  async function recheck() {
    await action("recheck", async () => {
      const r = await api("/title-search/execute", { body: {
        addressText: rec.address_text, stateCode: rec.state_code, district: rec.district_name, taluk: rec.taluk_name || null, village: rec.village_name,
        locality: rec.locality, pincode: rec.pincode, latitude: rec.latitude, longitude: rec.longitude, surveyNumber: rec.survey_number || null,
        claimedOwnerName: rec.claimed_owner_name, streamProgress: false, startImmediately: false
      } });
      nav(`/search/${r.searchId}`);
    });
  }

  if (!rec) return <main>{error ? <div className="form-error">{error}</div> : <div className="empty">Loading search…</div>}</main>;
  const title = rec.survey_number ? `Survey ${rec.survey_number}${rec.sub_division_hissa ? `/${rec.sub_division_hissa}` : ""}, ${rec.village_name}` : rec.village_name;

  return (
    <main>
      <section className="run-head">
        <div className="stack" style={{ gap: 4 }}>
          <div className="eyebrow">{rec.tier_type === "ESCROW_LINKED" ? "Escrow verification" : rec.tier_type === "BANK_B2B_API" ? "Bank API search" : "Title search"} · live data</div>
          <h1>{title}</h1>
          <p className="muted">{rec.address_text ? `${rec.address_text} · ` : ""}{[rec.taluk_name, rec.district_name, rec.state_code].filter(Boolean).join(", ")}{rec.claimed_owner_name ? ` · owner: ${rec.claimed_owner_name}` : ""}</p>
        </div>
        <div className="stack" style={{ gap: 4, justifyItems: "end" }}>
          <span className="clock" aria-live="off">{elapsed.toFixed(1)} s</span>
          <StatusPill status={rec.status} />
        </div>
      </section>

      {error && <div className="form-error" role="alert">{error}</div>}

      {rec.status === "QUEUED" && rec.tier_type !== "ESCROW_LINKED" && (
        <section className="card">
          <div className="card-head"><h2>Add official records, then start</h2></div>
          <RecordsUpload stateCode={rec.state_code} docs={docs} onChange={setDocs} />
          <div className="row"><button className="primary" disabled={!!busy} onClick={startWithDocs}>{busy === "start" ? "Starting…" : docs.length ? "Upload and start the search" : "Start without records"}</button></div>
        </section>
      )}

      {a && (
        <div className={`verdict-band ${rec.verdict === "CLEAN_TITLE" ? "ok" : rec.verdict === "REJECTED" ? "bad" : "warn"}`}>
          <div className="stack" style={{ gap: 2 }}>
            <span className="stamp">{rec.verdict === "CLEAN_TITLE" ? "Clean title" : rec.verdict === "REJECTED" ? "Defect found" : "Needs advocate review"}</span>
            <span className="small">{a.rules.filter((r: any) => r.hit).map((r: any) => r.label).join(" · ") || "Every rule passed"}</span>
          </div>
          <div className="row">
            <span className="mono" style={{ fontSize: "1.6rem", fontWeight: 600 }}>{rec.encumbrance_clearance_score}<span className="muted small">/100</span></span>
            {rec.certificate_id && <a className="btn primary" href={fileUrl(`/api/v1/certificates/${rec.certificate_id}.pdf`)} target="_blank" rel="noreferrer">{rec.certificate_id.startsWith("TCC") ? "Certificate PDF" : "Signed report PDF"}</a>}
            {rec.certificate_id && <Link className="btn" to={`/verify/${rec.certificate_id}`}>Verify</Link>}
            {rec.escrow && <Link className="btn" to={`/escrow/${rec.escrow.escrow_id}`}>Escrow: {rec.escrow.escrow_state.replace(/_/g, " ").toLowerCase()}</Link>}
            {!rec.documents?.length && rec.tier_type !== "ESCROW_LINKED" && ["COMPLETED", "MANUAL_REVIEW"].includes(rec.status) && <button disabled={!!busy} onClick={recheck}>Re-check with EC & RoR</button>}
          </div>
        </div>
      )}

      <section className="card" aria-labelledby="locH">
        <div className="card-head"><h2 id="locH">Location</h2>{loc?.sources?.length ? <span className="small muted">{loc.sources.join(" + ")}</span> : null}</div>
        <div className="grid2">
          <MapView lat={loc?.lat ?? rec.latitude} lon={loc?.lon ?? rec.longitude} height={220} />
          <div className="stack">
            <dl className="kv">
              <dt>State</dt><dd>{location?.state?.name ?? rec.state_code}</dd>
              <dt>District</dt><dd>{rec.district_name || "—"}</dd>
              <dt>{location?.state?.hierarchy?.[1] ?? "Taluk"}</dt><dd>{rec.taluk_name || loc?.taluk || "—"}</dd>
              <dt>Village / locality</dt><dd>{rec.village_name}{rec.locality && rec.locality !== rec.village_name ? ` · ${rec.locality}` : ""}</dd>
              <dt>PIN</dt><dd>{rec.pincode || "—"}{loc?.postOffices?.length ? <span className="muted small"> · {loc.postOffices.slice(0, 3).join(", ")}</span> : null}</dd>
              <dt>Survey no.</dt><dd>{rec.survey_number || <span className="muted">not given</span>}</dd>
            </dl>
            {loc?.warnings?.map((w: string, i: number) => <div key={i} className="notice small">{w}</div>)}
            {portals.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <h3>Official portals</h3>
                {portals.map((p: any) => (
                  <div key={p.url} className="row small"><span className={`dot ${p.reachable === true ? "dot-ok" : p.reachable === false ? "dot-bad" : ""}`} /><a href={p.url} target="_blank" rel="noreferrer">{p.role}: {p.name}</a><span className="muted">{p.note}</span></div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="agentsH">
        <div className="card-head"><h2 id="agentsH">Four checks, run in parallel</h2>{running && <span className="pill run"><span className="dot pulse" />live</span>}</div>
        <div className="agents">
          {ROLES.map((role) => {
            const ag = agents[role];
            const run = runsByRole[role];
            const status = ag?.status ?? run?.status ?? (rec.status === "QUEUED" ? "QUEUED" : "STREAMING");
            const findings = run?.extracted_json?.findings ?? [];
            const docsForRole = role === "RECORDS" ? rec.documents ?? [] : [];
            return (
              <div className="agent" key={role}>
                <div className="agent-top">
                  <div><h3>{ROLE_TITLE[role]}</h3><div className="portal">{ROLE_SOURCE[role]}</div></div>
                  <StatusPill status={status} />
                </div>
                <ul className="log">
                  {(ag?.steps ?? []).map((s, i, arr) => (
                    <li key={i} className={`${i === arr.length - 1 ? "last" : ""} ${s.waiting ? "waiting" : ""}`}><span className="t">{s.t.toFixed(1)}s</span><span>{s.text}</span></li>
                  ))}
                  {!ag?.steps.length && <li><span className="t">—</span><span>{rec.status === "QUEUED" ? (rec.tier_type === "ESCROW_LINKED" ? "Starts when the advance is credited" : "Waiting to start") : run ? (run.error ?? "Done") : "Connecting…"}</span></li>}
                </ul>
                {role === "RECORDS" && docsForRole.length > 0 && (
                  <ul className="links">{docsForRole.map((d: any) => <li key={d.document_id}><StatusPill status={d.status === "EXTRACTED" ? "SUCCESS" : d.status === "FAILED" ? "FAILED" : "QUEUED"} /> {d.filename} <span className="muted small">{d.kind}{d.error ? ` · ${d.error}` : d.extracted_json ? ` · ${d.extracted_json.encumbrances.length} transactions, ${d.extracted_json.currentOwnerNames.length} owner(s)` : ""}</span></li>)}</ul>
                )}
                {role === "RECORDS" && !docsForRole.length && rec.status !== "QUEUED" && <div className="hint">No EC or RoR added — the title can't be certified clean without them.</div>}
                <Findings list={findings} />
                <SearchLog log={run?.search_log ?? []} />
                {status === "NOT_CONFIGURED" && <Link className="small" to="/settings">Add your free TinyFish key →</Link>}
              </div>
            );
          })}
        </div>
      </section>

      {(ocr?.transliterations?.length > 0 || a) && (
        <section className="card" aria-labelledby="readH">
          <div className="card-head"><h2 id="readH">Owner identity</h2><span className="muted small">{ocr?.documentAi ? `records read with ${ocr.documentAi}` : ""}</span></div>
          <div className="grid2">
            <dl className="kv">
              <dt>Owner on record</dt><dd>{a?.lastOwnerName ? <Name value={a.lastOwnerName} latin={translit.get(a.lastOwnerName)} /> : <span className="muted">not established — add the Record of Rights</span>}</dd>
              <dt>Seller declared</dt><dd>{rec.claimed_owner_name ?? "—"}</dd>
              <dt>Match</dt><dd>{a?.ownerMatch ? <><span className={`pill ${a.ownerMatch.kind === "exact" ? "ok" : a.ownerMatch.kind === "variance" ? "warn" : "bad"}`}>{a.ownerMatch.kind === "exact" ? "Same person" : a.ownerMatch.kind === "variance" ? "Same person, spelling differs" : "Different person"}</span> <span className="small">{Math.round(a.ownerMatch.score * 100)}% · {a.ownerMatch.notes.join("; ") || "identical"}</span></> : "—"}</dd>
            </dl>
            {ocr?.transliterations?.length > 0 && (
              <div className="tablewrap"><table><thead><tr><th>As printed</th><th>Romanised</th></tr></thead><tbody>
                {ocr.transliterations.map((t: any) => <tr key={t.original}><td className="indic">{t.original}</td><td>{t.latin}</td></tr>)}
              </tbody></table></div>
            )}
          </div>
        </section>
      )}

      {a && (
        <>
          <section className="card" aria-labelledby="scoreH">
            <div className="card-head"><h2 id="scoreH">Rule-based title score</h2><span className="mono small muted">{a.rulesetVersion}</span></div>
            <div className="scorebox">
              <Gauge score={a.score} verdict={rec.verdict ?? a.verdict} />
              <div>
                {(["VETO", "DEDUCTION", "GUARDRAIL"] as const).map((k) => (
                  <div key={k}>
                    <div className="group-label">{k === "VETO" ? "Hard vetoes · any one sets S = 0" : k === "DEDUCTION" ? "Deductions" : "Guardrails · cannot auto-clear"}</div>
                    {a.rules.filter((r: any) => r.kind === k).map((r: any) => (
                      <div key={r.id} className={`rule ${r.hit ? "hit" : ""} ${r.kind}`}>
                        <span className="id">{r.id}</span>
                        <span>{r.label}<span className="why">{r.detail}</span></span>
                        <span className={`v ${r.hit ? "" : "pass"}`}>{r.hit ? (k === "VETO" ? "× 0" : k === "DEDUCTION" ? `−${r.weight}` : "cap 89") : "pass"}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="formula">S = max(0, 100 − {a.rules.filter((r: any) => r.kind === "DEDUCTION" && r.hit).reduce((s: number, r: any) => s + r.weight, 0)}) × {a.rules.filter((r: any) => r.kind === "VETO").map((r: any) => `(1−${r.hit ? 1 : 0})`).join("")} = {a.rawScore}{a.rawScore !== a.score ? ` → capped ${a.score}` : ""}</div>
          </section>

          <div className="grid2">
            <section className="card">
              <h2>30-year chain of title</h2>
              {a.chain.links.length ? (
                <div className="chain">
                  {a.chain.links.map((l: any, i: number) => (
                    <span key={i} style={{ display: "contents" }}>
                      {i === 0 && <span className="o"><b className={isIndic(l.from) ? "indic" : ""}>{l.from}</b><span className="muted small">owner before {l.date.slice(0, 4)}</span></span>}
                      <span className="e">{l.type.toLowerCase().replace(/_/g, " ")}<br />{l.date.slice(0, 4)} →</span>
                      <span className={`o ${i === a.chain.links.length - 1 ? "cur" : ""}`}><b className={isIndic(l.to) ? "indic" : ""}>{l.to}</b><span className="muted small">{l.evidence.join(", ")}</span></span>
                    </span>
                  ))}
                </div>
              ) : <div className="empty">Comes from the Encumbrance Certificate and Record of Rights. Add them to see the ownership chain.</div>}
              {a.chain.breaks.map((b: any, i: number) => <div key={i} className="alert">{b.problem}</div>)}
              {a.chain.lagDetail && <div className="notice">{a.chain.lagDetail}</div>}
            </section>
            <section className="card">
              <h2>Mortgages and bank charges</h2>
              {a.liens.length ? (
                <div className="tablewrap"><table><thead><tr><th>Lender</th><th>Charge</th><th className="num">Amount</th><th>Status</th></tr></thead><tbody>
                  {a.liens.map((l: any) => (
                    <tr key={l.documentNumber}><td>{l.lender}</td><td className="mono small">{l.documentNumber}<br />{l.registrationDate}{l.loanReference ? ` · ${l.loanReference}` : ""}</td><td className="num">{inr(l.amountINR)}</td>
                      <td>{l.released ? <span className="pill ok">Released</span> : <span className="pill bad">Active</span>}<div className="small muted">{l.released ? l.releasedBy : l.reason}</div></td></tr>
                  ))}
                </tbody></table></div>
              ) : <div className="empty">No mortgages in the EC and no bank notices for this property.</div>}
            </section>
          </div>
        </>
      )}

      {rec.review && (
        <section className="card">
          <div className="card-head"><h2>Empanelled advocate review</h2><StatusPill status={rec.review.decision ? (rec.review.decision === "APPROVE" ? "CLEAN_TITLE" : "REJECTED") : "MANUAL_REVIEW"} /></div>
          <dl className="kv">
            <dt>Why</dt><dd>{rec.review.reason}</dd>
            <dt>Due</dt><dd>{when(rec.review.sla_due_at)}</dd>
            {rec.review.decision && <><dt>Decision</dt><dd>{rec.review.decision} by {rec.review.advocate_name} · {when(rec.review.decided_at)}</dd><dt>Notes</dt><dd>{rec.review.notes}</dd></>}
          </dl>
          {!rec.review.decision && user && ["ADVOCATE", "ADMIN"].includes(user.role) && <Link className="btn primary" to="/advocate">Open in the review console</Link>}
          {!rec.review.decision && user && !["ADVOCATE", "ADMIN"].includes(user.role) && <p className="small muted">An advocate checks the flagged items. In the demo, sign in as advocate@demo.in to decide.</p>}
        </section>
      )}

      {(result || rec.certificate_id) && (
        <section className="card">
          <div className="card-head"><h2>{rec.certificate_id?.startsWith("TCC") ? "Title Clearance Certificate" : "Signed report"}</h2><span className="mono small">{rec.certificate_id}</span></div>
          <dl className="kv">
            <dt>Signed</dt><dd>Class-3 document signer · serial {rec.output_json?.certificateMetadata?.dscSignatureSerial}</dd>
            <dt>Payload SHA-256</dt><dd className="hash">{rec.output_json?.certificateMetadata?.sha256DocumentHash}</dd>
            <dt>Evidence bundle</dt><dd className="hash">{rec.evidence_sha256_hash}</dd>
            {result?.ledger && <><dt>Ledger</dt><dd>row #{result.ledger.sequenceNo} · <span className="hash">{result.ledger.hash}</span></dd></>}
            <dt>Completed</dt><dd>{when(rec.completed_at)} · {(rec.execution_duration_ms / 1000).toFixed(1)} s end to end</dd>
          </dl>
          <details><summary className="small" style={{ cursor: "pointer" }}>Canonical output (PDF §5.1)</summary><pre className="code">{JSON.stringify(rec.output_json, null, 2)}</pre></details>
        </section>
      )}

      {(rec.monitor?.length > 0 || feed.length > 0) && (
        <section className="card">
          <div className="card-head"><h2>Escrow & monitoring activity</h2>
            {rec.monitor?.[0] && <button disabled={!!busy} onClick={() => action("run", () => api(`/monitor/${rec.monitor[0].subscription_id}/run`, { body: {} }))}>{busy === "run" ? "Checking…" : "Run monitoring check now"}</button>}
          </div>
          {rec.monitor?.[0] && <p className="small muted">Fresh TinyFish searches for new bank notices, court cases and notifications every {rec.monitor[0].interval_minutes} min until {String(rec.monitor[0].until_date).slice(0, 10)} · last check {when(rec.monitor[0].last_run_at)} · {rec.monitor[0].last_status ?? "not run yet"}</p>}
          {rec.alerts?.map((al: any, i: number) => <div key={i} className="alert"><b>{al.kind.replace(/_/g, " ")}</b> · <a href={al.detail.url} target="_blank" rel="noreferrer">{al.detail.title}</a> · {when(al.created_at)}</div>)}
          {feed.length > 0 && <ul className="timeline">{feed.map((f, i) => <li key={i}><span className="t">{new Date(f.at).toLocaleTimeString("en-IN")}</span><span style={{ color: f.kind === "bad" ? "var(--bad)" : f.kind === "warn" ? "var(--warn)" : undefined }}>{f.text}</span></li>)}</ul>}
        </section>
      )}
    </main>
  );
}
