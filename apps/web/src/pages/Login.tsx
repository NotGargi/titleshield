import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, session } from "../api.ts";
import { ErrorNote } from "../components/ui.tsx";

const DEMO = [
  ["buyer@demo.in", "Buyer", "runs searches and escrows"],
  ["advocate@demo.in", "Advocate", "reviews conditional titles"],
  ["bank@demo.in", "Bank officer", "sees the bank's API searches"],
  ["admin@demo.in", "Admin", "everything, plus ledger anchoring"]
] as const;

export function LoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(e?: React.FormEvent, creds?: { email: string; password: string }) {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = mode === "register" && !creds
        ? await api("/auth/register", { body: { email, password, name } })
        : await api("/auth/login", { body: creds ?? { email, password } });
      session.set(r.token, r.user);
      nav(params.get("next") ?? "/");
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <main>
      <div className="split">
        <form className="card" onSubmit={go}>
          <h1>{mode === "login" ? "Sign in" : "Create an account"}</h1>
          {mode === "register" && <label className="field">Full name<input id="name" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>}
          <label className="field">Email<input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <label className="field">Password<input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
          <ErrorNote error={error} />
          <button className="primary" type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
          <button type="button" className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "New buyer? Create an account" : "Have an account? Sign in"}</button>
        </form>
        <section className="card">
          <h2>Demo accounts</h2>
          <p className="small muted">Password for all of them: <span className="mono">demo1234</span></p>
          <div className="demo-logins">
            {DEMO.map(([e, role, what]) => (
              <button key={e} type="button" className="chip" onClick={() => go(undefined, { email: e, password: "demo1234" })}><b>{role} · {e}</b><span>{what}</span></button>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
