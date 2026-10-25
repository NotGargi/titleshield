import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, when } from "../api.ts";
import { StatusPill } from "../components/ui.tsx";

export function SearchesPage() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api("/title-search").then(setRows).catch((e) => setError(e.message)); }, []);
  return (
    <main>
      <div className="row"><h1>My searches</h1><span className="spacer" /><Link className="btn primary" to="/">New title search</Link></div>
      {error && <div className="form-error">{error}</div>}
      <section className="card">
        {!rows ? <div className="empty">Loading…</div> : rows.length === 0 ? <div className="empty">No searches yet. <Link to="/">Run your first title search</Link>.</div> : (
          <div className="tablewrap"><table>
            <thead><tr><th>Property</th><th>Type</th><th>Status</th><th>Verdict</th><th className="num">Score</th><th>Certificate</th><th>Started</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.search_id}>
                <td><Link to={`/search/${r.search_id}`}>{r.survey_number ? `${r.survey_number}, ` : ""}{r.village_name}</Link><div className="small muted">{[r.taluk_name, r.district_name, r.state_code].filter(Boolean).join(", ")}</div></td>
                <td className="small">{r.tier_type.replace(/_/g, " ").toLowerCase()}</td>
                <td><StatusPill status={r.status} /></td>
                <td>{r.verdict ? <StatusPill status={r.verdict} /> : "—"}</td>
                <td className="num">{r.encumbrance_clearance_score ?? "—"}</td>
                <td className="mono small">{r.certificate_id ? <Link to={`/verify/${r.certificate_id}`}>{r.certificate_id}</Link> : "—"}</td>
                <td className="small">{when(r.created_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </main>
  );
}
