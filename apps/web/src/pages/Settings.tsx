import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { ErrorNote } from "../components/ui.tsx";

function Meter({ used, max, label }: { used: number; max: number; label: string }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row small" style={{ justifyContent: "space-between" }}><span>{label}</span><span className="mono">{used.toLocaleString("en-IN")} / {max.toLocaleString("en-IN")}</span></div>
      <div className="meter"><i style={{ width: `${pct}%` }} className={pct > 85 ? "hot" : ""} /></div>
    </div>
  );
}

/** Blueprint Phase 1: Search alone → Fetch a known public page → a Search result into Fetch. */
function Diagnostics({ onDone }: { onDone: () => void }) {
  const [r, setR] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true); setError(null);
    try { setR(await api("/settings/diagnostics", { body: {} })); onDone(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row"><button type="button" disabled={busy} onClick={run}>{busy ? "Running…" : "Run step-by-step diagnostics"}</button><span className="hint">≈ 1 search + 2 pages</span></div>
      {r && <ol className="diag">{r.steps.map((s: any) => (
        <li key={s.step} className={s.ok ? "ok-text" : "bad-text"}><b>{s.ok ? "✓" : "✗"} {s.step}</b> <span className="muted small">{s.ms} ms</span><div className="small">{s.detail}</div>
          {s.sample && <ul className="links">{s.sample.map((x: any) => <li key={x.url}><a href={x.url} target="_blank" rel="noreferrer">{x.title || x.url}</a></li>)}</ul>}</li>
      ))}</ol>}
      <ErrorNote error={error} />
    </div>
  );
}

function KeyCard({ service, title, children, s, onSaved, locked }: { service: "tinyfish" | "gemini"; title: string; children: React.ReactNode; s: any; onSaved: () => void; locked?: boolean }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = service === "tinyfish" ? "tinyfishApiKey" : "geminiApiKey";

  async function save(v: string) {
    setBusy("save"); setError(null); setMsg(null);
    try { await api("/settings", { method: "PUT", body: { [field]: v } }); setValue(""); onSaved(); if (v) await test(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }
  async function test() {
    setBusy("test"); setMsg(null);
    try {
      const r = await api("/settings/test", { body: { service } });
      setMsg(r.ok ? { ok: true, text: service === "tinyfish" ? `Connected. A live search returned ${r.results} result${r.results === 1 ? "" : "s"}${r.sample?.[0] ? ` (e.g. ${r.sample[0].title})` : ""}.` : `Connected to ${r.model}.` } : { ok: false, text: r.error });
      onSaved();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(""); }
  }

  return (
    <section className="card">
      <div className="card-head"><h2>{title}</h2><span className={`pill ${s.configured ? "ok" : "warn"}`}>{s.configured ? `Key saved ${s.masked} · ${s.source === "env" ? ".env" : "in app"}` : "No key"}</span></div>
      {children}
      {locked ? <p className="small muted">On this hosted demo the key is set by the host and can't be changed here.</p> : <form className="row" style={{ flexWrap: "nowrap" }} onSubmit={(e) => { e.preventDefault(); if (value.trim()) save(value.trim()); }}>
        <input id={`${service}Key`} type="password" autoComplete="off" placeholder={s.configured ? "Paste a new key to replace it" : "Paste your API key"} value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="primary" type="submit" disabled={!value.trim() || !!busy}>{busy === "save" ? "Saving…" : "Save"}</button>
      </form>}
      <div className="row">
        <button type="button" disabled={!s.configured || !!busy} onClick={test}>{busy === "test" ? "Testing…" : "Test connection"}</button>
        {!locked && s.configured && s.source === "app" && <button type="button" className="link" disabled={!!busy} onClick={() => save("")}>Remove key</button>}
      </div>
      {msg && <div className={msg.ok ? "notice" : "form-error"}>{msg.text}</div>}
      <ErrorNote error={error} />
    </section>
  );
}

export function SettingsPage() {
  const [s, setS] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api("/settings").then(setS).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  return (
    <main>
      <h1>Settings</h1>
      <p className="muted" style={{ maxWidth: "70ch" }}>TitleShield runs on free services only. Keys are stored encrypted on this server. Nothing here needs a card or a purchase.</p>
      <ErrorNote error={error} />
      {s && (
        <div className="grid2">
          <KeyCard service="tinyfish" title="TinyFish (required for web checks)" s={s.tinyfish} onSaved={load} locked={s.locked}>
            <ol className="small steps">
              <li>Sign up at <a href="https://agent.tinyfish.ai/api-keys" target="_blank" rel="noreferrer">agent.tinyfish.ai</a> — no card needed.</li>
              <li>Create an API key and paste it below.</li>
            </ol>
            <p className="small muted">Only TinyFish <b>Search</b> and <b>Fetch</b> are used, never the browser Agent, Browser sessions, Vault or Monitor. Search results are validated (no private, local or duplicate URLs; official domains preferred) before anything is fetched. Results are cached, retries are bounded, and every call is metered against the credit budget below. A check that can't retrieve its evidence is marked incomplete and can never produce a clean title.</p>
            {s.tinyfish.usage && (
              <div className="stack">
                {s.tinyfish.usage.credits && <Meter label={`Project credits used (${s.tinyfish.usage.credits.perSearch} per search, ${s.tinyfish.usage.credits.perFetch} per page read)`} used={s.tinyfish.usage.credits.used} max={s.tinyfish.usage.credits.budget} />}
                <Meter label="Searches today (30 / min, 500 / hour)" used={s.tinyfish.usage.search.used} max={s.tinyfish.limits.searchPerHour} />
                <Meter label="Pages read today" used={s.tinyfish.usage.fetch.used} max={s.tinyfish.limits.fetchPerDay} />
              </div>
            )}
            {s.tinyfish.configured && <Diagnostics onDone={load} />}
          </KeyCard>
          <KeyCard service="gemini" title="Gemini (optional, reads scans)" s={s.gemini} onSaved={load} locked={s.locked}>
            <ol className="small steps">
              <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a> and create a free API key.</li>
              <li>Paste it below.</li>
            </ol>
            <p className="small muted">Reads scanned or photographed EC, RTC, Khatauni and deeds in Indian languages with {s.gemini.model} on the free tier. Without it, digital PDFs downloaded from the portals are still read from their text.</p>
          </KeyCard>
        </div>
      )}
    </main>
  );
}
