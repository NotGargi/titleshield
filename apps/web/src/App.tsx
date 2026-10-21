import { createContext, useContext, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, session, type User } from "./api.ts";
import { HomePage } from "./pages/Home.tsx";
import { SearchPage } from "./pages/Search.tsx";
import { SearchesPage } from "./pages/Searches.tsx";
import { EscrowNewPage, EscrowListPage } from "./pages/EscrowNew.tsx";
import { EscrowPage } from "./pages/Escrow.tsx";
import { AdvocatePage } from "./pages/Advocate.tsx";
import { VerifyPage } from "./pages/Verify.tsx";
import { LedgerPage } from "./pages/Ledger.tsx";
import { BankApiPage } from "./pages/BankApi.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { ChainPage, ChainTxPage } from "./pages/Chain.tsx";

export interface Meta {
  tinyfish: { configured: boolean; source: string; tier: string; products: string[]; usage: any };
  workflowEngine: string;
  documentAi: string | null;
  storage: string;
  platformFeeBps: number;
  chain: { name: string; mode: string; chainId: number; explorer: string | null } | null;
  states: Array<{ code: string; name: string; language: string; hierarchy: string[]; revenuePortal: { name: string; url: string } | null; encumbrancePortal: { name: string; url: string } | null; highCourt: string; rera: { name: string; url: string } | null }>;
  demoBankApiKey?: string;
}

const Ctx = createContext<{ meta: Meta | null; user: User | null }>({ meta: null, user: null });
export const useApp = () => useContext(Ctx);

export function RequireLogin({ children, roles }: { children: React.ReactNode; roles?: string[] }) {
  const { user } = useApp();
  const loc = useLocation();
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (roles && !roles.includes(user.role)) return <main><div className="card"><h2>Not available for your account</h2><p className="muted">This page is for {roles.join(" / ").toLowerCase()} accounts. Sign in with one from the login page.</p></div></main>;
  return <>{children}</>;
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [user, setUser] = useState<User | null>(session.user);
  const nav = useNavigate();

  const loadMeta = () => api<Meta>("/meta").then(setMeta).catch(() => setMeta(null));
  useEffect(() => { loadMeta(); }, []);
  const loc = useLocation();
  useEffect(() => { if (loc.pathname === "/" || loc.pathname === "/settings") loadMeta(); }, [loc.pathname]);
  useEffect(() => {
    const on = () => setUser(session.user);
    window.addEventListener("ts-session", on);
    return () => window.removeEventListener("ts-session", on);
  }, []);

  return (
    <Ctx.Provider value={{ meta, user }}>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="logo">
            <svg width="24" height="24" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 8 13v17c0 15 10 26 24 30 14-4 24-15 24-30V13L32 4z" fill="currentColor" opacity=".18" /><path d="M21 33l7 7 15-16" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span>TitleShield <small>BHOOMITRUST</small></span>
          </NavLink>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>Title search</NavLink>
            <NavLink to="/escrow">Escrow</NavLink>
            {user && <NavLink to="/searches">My searches</NavLink>}
            {user && ["ADVOCATE", "ADMIN"].includes(user.role) && <NavLink to="/advocate">Advocate review</NavLink>}
            <NavLink to="/verify">Verify certificate</NavLink>
            <NavLink to="/ledger">Ledger</NavLink>
            <NavLink to="/bank-api">Bank API</NavLink>
            {user && <NavLink to="/settings">Settings</NavLink>}
          </nav>
          <div className="who">
            {user ? (<><span>{user.name}</span><button onClick={() => { session.clear(); nav("/"); }}>Sign out</button></>) : <NavLink to="/login" className="btn" style={{ background: "transparent", color: "inherit", borderColor: "rgba(255,255,255,.35)" }}>Sign in</NavLink>}
          </div>
        </div>
      </header>
      {meta && !meta.tinyfish.configured && (
        <div className="modebar">
          Web checks are off until a free TinyFish key is added. {user ? <NavLink to="/settings">Add it in Settings</NavLink> : <NavLink to="/login?next=/settings">Sign in to add it</NavLink>} · no card needed
        </div>
      )}
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/search/:id" element={<RequireLogin><SearchPage /></RequireLogin>} />
        <Route path="/searches" element={<RequireLogin><SearchesPage /></RequireLogin>} />
        <Route path="/escrow" element={<RequireLogin><EscrowListPage /></RequireLogin>} />
        <Route path="/escrow/new" element={<RequireLogin roles={["BUYER", "ADMIN", "BANK_OFFICER"]}><EscrowNewPage /></RequireLogin>} />
        <Route path="/escrow/:id" element={<RequireLogin><EscrowPage /></RequireLogin>} />
        <Route path="/advocate" element={<RequireLogin roles={["ADVOCATE", "ADMIN"]}><AdvocatePage /></RequireLogin>} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/verify/:certId" element={<VerifyPage />} />
        <Route path="/ledger" element={<LedgerPage />} />
        <Route path="/chain" element={<ChainPage />} />
        <Route path="/chain/tx/:hash" element={<ChainTxPage />} />
        <Route path="/bank-api" element={<BankApiPage />} />
        <Route path="/settings" element={<RequireLogin><SettingsPage /></RequireLogin>} />
        <Route path="*" element={<main><div className="card"><h2>Page not found</h2><NavLink to="/">Go to title search</NavLink></div></main>} />
      </Routes>
    </Ctx.Provider>
  );
}