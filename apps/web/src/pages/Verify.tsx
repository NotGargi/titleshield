import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, fileUrl, when } from "../api.ts";
import { ErrorNote, StatusPill } from "../components/ui.tsx";

export function VerifyPage() {
  const { certId } = useParams();
  const nav = useNavigate();
  const [lookup, setLookup] = useState(certId ?? "");
  const [v, setV] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<any>(null);

  useEffect(() => {
    setV(null); setError(null);
    if (certId) api(`/verify/${encodeURIComponent(certId)}`).then(setV).catch((e) => setError(e.message));
  }, [certId]);

  async function check(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    try { setUpload(await api("/verify/upload", { form: fd })); } catch (e) { setError((e as Error).message); }
  }

  const p = v?.payload;
  return (
    <main>
      <h1>Verify a certificate</h1>
      <div className="split">
        <div className="stack">
          <form className="card" onSubmit={(e) => { e.preventDefault(); if (lookup.trim()) nav(`/verify/${lookup.trim()}`); }}>
            <h2>By certificate ID</h2>
            <div className="row" style={{ flexWrap: "nowrap" }}><input id="certLookup" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="TCC-KA-20261020-12345" /><button type="submit" className="primary">Check</button></div>
          </form>
          <section className="card">
            <h2>By PDF file</h2>
            <p className="small muted">Checks the file's SHA-256 against the ledger. Any change to the PDF — even one byte — will not match.</p>
            <input id="certFile" type="file" accept="application/pdf" onChange={(e) => e.target.files?.[0] && check(e.target.files[0])} />
            {upload && (upload.match
              ? <div className="notice">Genuine. Matches {upload.certificateId} issued {when(upload.issuedAt)}.</div>
              : <div className="alert">{upload.message}<div className="hash">{upload.sha256}</div></div>)}
          </section>
        </div>

        <div className="stack">
          <ErrorNote error={error} />
          {v && (
            <>
              <div className={`verdict-band ${p.verdict === "CLEAN_TITLE" ? "ok" : p.verdict === "REJECTED" ? "bad" : "warn"}`}>
                <div className="stack" style={{ gap: 2 }}>
                  <span className="stamp">{v.chainValidUpToThisRow ? "Authentic" : "Ledger mismatch"}</span>
                  <span className="small">{v.documentType.replace(/_/g, " ").toLowerCase()} · ledger row #{v.sequenceNo} · issued {when(v.issuedAt)}</span>
                </div>
                <a className="btn primary" href={fileUrl(`/api/v1/certificates/${v.certificateId}.pdf`)} target="_blank" rel="noreferrer">Open PDF</a>
              </div>
              <section className="card">
                <h2>{p.propertyIdentifier.surveyNumber ? `Survey ${p.propertyIdentifier.surveyNumber}, ` : ""}{p.propertyIdentifier.village}</h2>
                <dl className="kv">
                  <dt>Location</dt><dd>{[p.propertyIdentifier.taluk, p.propertyIdentifier.district, p.propertyIdentifier.state].filter(Boolean).join(", ")}</dd>
                  <dt>Owner on record</dt><dd>{p.lastOwnerName || "not established"}</dd>
                  <dt>Result</dt><dd><StatusPill status={p.verdict} /> score {p.encumbranceClearanceScore}/100</dd>
                  <dt>Active mortgage</dt><dd>{p.hasActiveMortgage ? "Yes" : "No"}</dd>
                  <dt>Pending cases</dt><dd>{p.pendingLitigationCount}</dd>
                </dl>
              </section>
              <section className="card">
                <h2>Integrity checks</h2>
                <table><tbody>
                  <tr><td>Hash chain valid up to this row</td><td>{v.chainValidUpToThisRow ? <span className="pill ok">Pass</span> : <span className="pill bad">Fail</span>}</td></tr>
                  <tr><td>Hourly Merkle anchor</td><td>{v.merkle ? (v.merkle.verified ? <span className="pill ok">Included</span> : <span className="pill bad">Not included</span>) : <span className="pill">Pending next anchor</span>}{v.merkle && <span className="small muted"> · TSA {v.merkle.tsaStatus}</span>}</td></tr>
                  <tr><td>Evidence retention lock</td><td>{v.retention?.mode} until {v.retention?.retainUntil?.slice(0, 10)}</td></tr>
                  <tr><td>Signer</td><td className="small">{v.signer.subject} · serial {v.signer.serial} · {v.signer.issuer}{v.signer.development && <span className="pill warn" style={{ marginLeft: 6 }}>dev certificate</span>}</td></tr>
                </tbody></table>
                <dl className="kv small">
                  <dt>PDF SHA-256</dt><dd className="hash">{v.pdfSha256}</dd>
                  <dt>Payload SHA-256</dt><dd className="hash">{p.certificateMetadata?.sha256DocumentHash}</dd>
                  <dt>Evidence SHA-256</dt><dd className="hash">{v.evidenceSha256}</dd>
                  <dt>Previous row</dt><dd className="hash">{v.previousRowHash}</dd>
                  <dt>This row</dt><dd className="hash">{v.currentRowHash}</dd>
                  {v.merkle && <><dt>Merkle root</dt><dd className="hash">{v.merkle.root}</dd></>}
                </dl>
              </section>
            </>
          )}
          {!v && !error && <div className="empty">Enter a certificate ID or upload a PDF.</div>}
        </div>
      </div>
    </main>
  );
}
