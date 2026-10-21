import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, when } from "../api.ts";
import { useApp } from "../App.tsx";
import { ErrorNote } from "../components/ui.tsx";

export function LedgerPage() {
  const { user } = useApp();
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api("/ledger").then(setD).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  return (
    <main>
      <h1>Certificate ledger</h1>
      <p className="muted" style={{ maxWidth: "72ch" }}>Every certificate and defect report is appended to a hash chain: each row's SHA-256 includes the previous row's, so changing any past entry breaks every entry after it. The database also refuses updates and deletes. Each hour's rows are combined into a Merkle root and sent to an RFC 3161 timestamp authority.</p>
      <ErrorNote error={error} />
      {d && (
        <>
          <section className="card">
            <div className="card-head">
              <h2>Integrity</h2>
              <div className="row">
                {d.integrity.ok ? <span className="pill ok">Chain intact · {d.integrity.checked} rows</span> : <span className="pill bad">Broken at row {d.integrity.brokenAt}: {d.integrity.reason}</span>}
                {user?.role === "ADMIN" && <button onClick={() => api("/ledger/anchor", { body: {} }).then(load).catch((e) => setError(e.message))}>Anchor this hour now</button>}
              </div>
            </div>
            <dl className="kv small"><dt>Head hash</dt><dd className="hash">{d.integrity.head}</dd></dl>
          </section>
          <section className="card">
            <h2>Latest entries</h2>
            {!d.rows.length ? <div className="empty">No certificates issued yet.</div> : (
              <div className="tablewrap"><table>
                <thead><tr><th className="num">#</th><th>Certificate</th><th>Type</th><th>Previous → this row</th><th>Recorded</th></tr></thead>
                <tbody>{d.rows.map((r: any) => (
                  <tr key={r.sequence_no}><td className="num">{r.sequence_no}</td><td className="mono small"><Link to={`/verify/${r.certificate_id}`}>{r.certificate_id}</Link></td>
                    <td className="small">{r.document_type.replace(/_/g, " ").toLowerCase()}</td>
                    <td className="hash">{r.previous_row_hash.slice(0, 14)}… → {r.current_row_hash.slice(0, 14)}…</td><td className="small">{when(r.recorded_at_iso)}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
          <section className="card">
            <h2>Hourly Merkle anchors</h2>
            {!d.anchors.length ? <div className="empty">No anchors yet. The current hour is anchored after it ends.</div> : (
              <div className="tablewrap"><table>
                <thead><tr><th>Hour (UTC)</th><th className="num">Rows</th><th>Merkle root</th><th>Timestamp authority</th></tr></thead>
                <tbody>{d.anchors.map((a: any) => <tr key={a.anchor_id}><td className="small">{when(a.period_start)}</td><td className="num">{a.leaf_count}</td><td className="hash">{a.merkle_root}</td><td className="small">{a.tsa_status}</td></tr>)}</tbody>
              </table></div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
