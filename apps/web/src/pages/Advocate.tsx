import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, when } from "../api.ts";
import { ErrorNote, StatusPill } from "../components/ui.tsx";

function Due({ at }: { at: string }) {
  const mins = Math.round((Date.parse(at) - Date.now()) / 60000);
  return <span className={`pill ${mins < 0 ? "bad" : mins < 30 ? "warn" : ""}`}>{mins < 0 ? `${-mins} min overdue` : `${mins} min left`}</span>;
}

function Decide({ searchId, onDone }: { searchId: string; onDone: () => void }) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (decision: "APPROVE" | "REJECT") => {
    setBusy(true); setError(null);
    try { await api(`/advocate/${searchId}/decision`, { body: { decision, notes } }); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="stack">
      <label className="field">What you checked (goes on the certificate)<textarea id={`notes-${searchId}`} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Verified Index-II for 1996–2004 at the SRO; no transactions. Mutation application for the 2024 deed is pending." /></label>
      <ErrorNote error={error} />
      <div className="row">
        <button className="ok" disabled={busy || notes.length < 10} onClick={() => go("APPROVE")}>Approve · release escrow</button>
        <button className="danger" disabled={busy || notes.length < 10} onClick={() => go("REJECT")}>Reject · refund buyer</button>
      </div>
    </div>
  );
}

export function AdvocatePage() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api("/advocate/queue").then(setRows).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  const open = rows?.filter((r) => !r.decision) ?? [];
  const done = rows?.filter((r) => r.decision) ?? [];
  return (
    <main>
      <h1>Advocate review console</h1>
      <p className="muted" style={{ maxWidth: "70ch" }}>Searches that score between 50 and 89, or hit a guardrail, wait here. Open the evidence, check the flagged items, and record what you verified. Your decision releases or refunds any escrow.</p>
      <ErrorNote error={error} />
      {!rows ? <div className="empty">Loading…</div> : !open.length ? <div className="empty">Nothing waiting for review.</div> : open.map((r) => (
        <section className="card" key={r.review_id}>
          <div className="card-head">
            <h2><Link to={`/search/${r.search_id}`}>{r.survey_number ? `Survey ${r.survey_number}, ` : ""}{r.village_name}</Link></h2>
            <div className="row"><span className="mono">{r.encumbrance_clearance_score}/100</span>{r.escrow_state && <StatusPill status={r.escrow_state} />}<Due at={r.sla_due_at} /></div>
          </div>
          <p className="small muted">{[r.taluk_name, r.district_name, r.state_code].filter(Boolean).join(", ")} · seller {r.claimed_owner_name ?? "—"} · {r.tier_type.replace(/_/g, " ").toLowerCase()} · opened {when(r.created_at)}</p>
          <div className="notice">{r.reason}</div>
          <Decide searchId={r.search_id} onDone={load} />
        </section>
      ))}
      {done.length > 0 && (
        <section className="card">
          <h2>Decided</h2>
          <div className="tablewrap"><table><thead><tr><th>Property</th><th>Decision</th><th>Notes</th><th>When</th></tr></thead><tbody>
            {done.map((r) => <tr key={r.review_id}><td><Link to={`/search/${r.search_id}`}>{r.survey_number ? `${r.survey_number}, ` : ""}{r.village_name}</Link></td><td><StatusPill status={r.decision === "APPROVE" ? "CLEAN_TITLE" : "REJECTED"} /></td><td className="small">{r.notes}</td><td className="small">{when(r.decided_at)}</td></tr>)}
          </tbody></table></div>
        </section>
      )}
    </main>
  );
}
