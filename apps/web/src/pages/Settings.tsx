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

function KeyCard({ service, title, children, s, onSaved }: { service: "tinyfish" | "gemini"; title: string; children: React.ReactNode; s: any; onSaved: () => void }) {
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
      <form className="row" style={{ flexWrap: "nowrap" }} onSubmit={(e) => { e.preventDefault(); if (value.trim()) save(value.trim()); }}>
        <input id={`${service}Key`} type="password" autoComplete="off" placeholder={s.configured ? "Paste a new key to replace it" : "Paste your API key"} value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="primary" type="submit" disabled={!value.trim() || !!busy}>{busy === "save" ? "Saving…" : "Save"}</button>
      </form>
      <div className="row">
        <button type="button" disabled={!s.configured || !!busy} onClick={test}>{busy === "test" ? "Testing…" : "Test connection"}</button>
        {s.configured && s.source === "app" && <button type="button" className="link" disabled={!!busy} onClick={() => save("")}>Remove key</button>}
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
          <KeyCard service="tinyfish" title="TinyFish (required for web checks)" s={s.tinyfish} onSaved={load}>
            <ol className="small steps">
              <li>Sign up at <a href="https://agent.tinyfish.ai/api-keys" target="_blank" rel="noreferrer">agent.tinyfish.ai</a> — no card needed.</li>
              <li>Create an API key and paste it below.</li>
            </ol>
            <p className="small muted">Only TinyFish's free <b>Search</b> and <b>Fetch</b> are used. The paid browser agent, Browser sessions and Monitor are not. The app stays under the free limits on its own and caches results so repeat searches cost nothing.</p>
            {s.tinyfish.usage && (
              <div className="stack">
                <Meter label="Searches today (30 / min, 500 / hour)" used={s.tinyfish.usage.search.used} max={s.tinyfish.limits.searchPerHour} />
                <Meter label="Pages read today" used={s.tinyfish.usage.fetch.used} max={s.tinyfish.limits.fetchPerDay} />
              </div>
            )}
          </KeyCard>
          <KeyCard service="gemini" title="Gemini (optional, reads scans)" s={s.gemini} onSaved={load}>
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
