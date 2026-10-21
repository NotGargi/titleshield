import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "../App.tsx";
import { Copy, ErrorNote } from "../components/ui.tsx";

const origin = typeof window !== "undefined" ? window.location.origin : "";

export function BankApiPage() {
  const { meta } = useApp();
  const key = meta?.demoBankApiKey ?? "<your API key>";
  const [res, setRes] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [sink, setSink] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const body = { addressText: "Sy. No. 42/2B, Hebbal, Bengaluru North, Bengaluru Urban, Karnataka 560024", surveyNumber: "42/2B", claimedOwnerName: "Venkatesh Murthy", clientReference: "HL-APP-20931" };
  const curl = `curl -X POST ${origin}/api/v1/title-search/execute \\
  -H "X-API-Key: ${key}" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(body)}'`;

  async function tryIt() {
    setError(null); setRes(null); setStatus(null);
    try {
      const r = await fetch(`/api/v1/title-search/execute`, { method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body) });
      const j = await r.json();
      setRes({ status: r.status, body: j });
      if (!r.ok) return;
      for (let i = 0; i < 120; i++) {
        await new Promise((x) => setTimeout(x, 1000));
        const s = await (await fetch(`/api/v1/title-search/${j.searchId}`, { headers: { "X-API-Key": key } })).json();
        setStatus(s);
        if (["COMPLETED", "FAILED", "MANUAL_REVIEW"].includes(s.status)) break;
      }
      setTimeout(loadSink, 800);
    } catch (e) { setError((e as Error).message); }
  }
  const loadSink = () => fetch("/api/v1/dev/webhook-sink").then((r) => r.json()).then(setSink).catch(() => {});
  useEffect(() => { loadSink(); }, []);

  return (
    <main>
      <h1>Bank API</h1>
      <p className="muted" style={{ maxWidth: "72ch" }}>Lenders call one endpoint per property. With an API key the request is accepted right away (HTTP 202) and the signed result is pushed to your webhook, so underwriting systems don't hold a connection open while state portals respond.</p>
      <div className="grid2">
        <section className="card">
          <h2>Request</h2>
          <dl className="kv small">
            <dt>Endpoint</dt><dd className="mono">POST /api/v1/title-search/execute</dd>
            <dt>Auth</dt><dd><span className="mono">X-API-Key</span> (mTLS client certificate terminated at your gateway in production)</dd>
            <dt>Idempotency</dt><dd><span className="mono">Idempotency-Key</span> header — a retry returns the same search</dd>
            <dt>Status</dt><dd className="mono">GET /api/v1/title-search/:searchId</dd>
            <dt>Live stream</dt><dd className="mono">GET /api/v1/title-search/:searchId/events</dd>
            <dt>Webhook</dt><dd><span className="mono">title_search.completed</span>, <span className="mono">monitor.alert</span> · HMAC-SHA256 in <span className="mono">X-TitleShield-Signature</span></dd>
            {meta?.demoBankApiKey && <><dt>Sandbox key</dt><dd className="mono">{meta.demoBankApiKey} <Copy text={meta.demoBankApiKey} /></dd></>}
          </dl>
          <div className="row"><span className="small muted">cURL</span><span className="spacer" /><Copy text={curl} /></div>
          <pre className="code">{curl}</pre>
          <button className="primary" onClick={tryIt} disabled={!meta?.demoBankApiKey}>Send this request</button>
          <ErrorNote error={error} />
        </section>
        <section className="card">
          <h2>Response</h2>
          {res ? <pre className="code">{`HTTP ${res.status}\n${JSON.stringify(res.body, null, 2)}`}</pre> : <div className="empty">Send the request to see the 202 response.</div>}
          {status && (
            <div className="stack">
              <div className="row"><b>Polling</b><span className="pill">{status.status}</span>{status.status === "COMPLETED" && <Link to={`/verify/${status.certificate_id}`}>{status.certificate_id}</Link>}</div>
              {status.output_json && <pre className="code">{JSON.stringify(status.output_json, null, 2)}</pre>}
            </div>
          )}
        </section>
      </div>
      <section className="card">
        <div className="card-head"><h2>Webhooks received by the sandbox bank</h2><button onClick={loadSink}>Refresh</button></div>
        {!sink.length ? <div className="empty">None yet.</div> : sink.slice(0, 5).map((s, i) => (
          <details key={i} open={i === 0}><summary className="small" style={{ cursor: "pointer" }}>{s.at} · {s.headers.event} · signature {String(s.headers.signature).slice(0, 16)}…</summary><pre className="code">{JSON.stringify(s.body, null, 2)}</pre></details>
        ))}
      </section>
    </main>
  );
}
