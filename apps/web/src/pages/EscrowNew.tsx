import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, inr, when } from "../api.ts";
import { useApp } from "../App.tsx";
import { ErrorNote, StatusPill } from "../components/ui.tsx";
import { EMPTY_LOCATION, LocationPicker, type LocationValue } from "../components/LocationPicker.tsx";
import { locationBody } from "./Home.tsx";

export function EscrowListPage() {
  const { user } = useApp();
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { api("/escrow").then(setRows).catch(() => setRows([])); }, []);
  return (
    <main>
      <div className="row"><h1>Title escrow</h1><span className="spacer" />{user && ["BUYER", "ADMIN", "BANK_OFFICER"].includes(user.role) && <Link className="btn primary" to="/escrow/new">New escrow</Link>}</div>
      <p className="muted" style={{ maxWidth: "70ch" }}>The buyer's advance is locked in the TitleEscrow smart contract as tINR, backed 1:1 by the trustee bank's escrow account. When TinyFish's agents finish the title search, the contract unlocks it to the seller on a clean title certificate, or sends it straight back to the buyer if a defect such as an undisclosed bank lien turns up. Money can only move to those two verified parties.</p>
      <section className="card">
        {!rows ? <div className="empty">Loading…</div> : !rows.length ? <div className="empty">No escrows yet.</div> : (
          <div className="tablewrap"><table>
            <thead><tr><th>Property</th><th>Buyer → Seller</th><th className="num">Advance</th><th>State</th><th>Created</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.escrow_id}>
                <td><Link to={`/escrow/${r.escrow_id}`}>{r.survey_number ? `${r.survey_number}, ` : ""}{r.village_name}</Link> <span className="muted small">{r.state_code}</span></td>
                <td className="small">{r.buyer_name} → {r.seller_name}</td>
                <td className="num">{inr(r.advance_deposit_amount_inr)}</td>
                <td><StatusPill status={r.escrow_state} /></td>
                <td className="small">{when(r.created_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </main>
  );
}

export function EscrowNewPage() {
  const { meta, user } = useApp();
  const nav = useNavigate();
  const [loc, setLoc] = useState<LocationValue>(EMPTY_LOCATION);
  const [buyer, setBuyer] = useState({ name: user?.name ?? "", accountNumber: "", ifsc: "" });
  const [seller, setSeller] = useState({ name: "", accountNumber: "", ifsc: "" });
  const [value, setValue] = useState("");
  const [pct, setPct] = useState("10");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = Number(value.replace(/[^\d.]/g, "")) || 0;
  const advance = (v * Number(pct)) / 100;
  const fee = (advance * (meta?.platformFeeBps ?? 25)) / 10000;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api("/escrow", { body: { property: locationBody(loc), buyer, seller, propertyValueINR: v, advancePercent: Number(pct), consentAccepted: consent } });
      nav(`/escrow/${r.escrow_id}`);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return (
    <main>
      <h1>Protect an advance with escrow</h1>
      <form className="split" onSubmit={submit}>
        <section className="card">
          <h2>Property</h2>
          <LocationPicker value={loc} onChange={setLoc} />
        </section>
        <div className="stack">
          <section className="card">
            <h2>Price</h2>
            <div className="fields">
              <label className="field">Agreed sale price (₹)<input id="eValue" required inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} /></label>
              <label className="field">Advance %<input id="ePct" type="number" min="1" max="50" value={pct} onChange={(e) => setPct(e.target.value)} /></label>
            </div>
            <div className="money">
              <span>Advance held in escrow</span><span className="v">{inr(advance)}</span>
              <span>Escrow fee ({(meta?.platformFeeBps ?? 25) / 100}%, only on release)</span><span className="v">{inr(fee)}</span>
              <span className="tot">Seller receives on clean title</span><span className="v tot">{inr(advance - fee)}</span>
              <span>Refund on a defect</span><span className="v">{inr(advance)} (100%)</span>
              <span>Held on-chain as</span><span className="v">{advance.toLocaleString("en-IN")} tINR</span>
            </div>
            <p className="small muted">A typical bank escrow charges 1%. UPI works up to ₹5,00,000; larger advances go by NEFT or RTGS.</p>
          </section>
          {(["Buyer", "Seller"] as const).map((who) => {
            const val = who === "Buyer" ? buyer : seller, set = who === "Buyer" ? setBuyer : setSeller;
            return (
              <section key={who} className="card">
                <h2>{who}</h2>
                <div className="fields">
                  <label className="field full">Name as on bank account{who === "Seller" ? " (and on the property records)" : ""}<input id={`${who}Name`} required value={val.name} onChange={(e) => set({ ...val, name: e.target.value })} /></label>
                  <label className="field">Account number<input id={`${who}Acc`} required inputMode="numeric" value={val.accountNumber} onChange={(e) => set({ ...val, accountNumber: e.target.value.replace(/\D/g, "") })} /></label>
                  <label className="field">IFSC<input id={`${who}Ifsc`} required value={val.ifsc} onChange={(e) => set({ ...val, ifsc: e.target.value.toUpperCase() })} /></label>
                </div>
                <p className="hint">{who === "Buyer" ? "Refunds go only to this account." : "Checked by a ₹1 penny drop; the release goes only to this account. (Sandbox bank: an account ending 0000 belongs to someone else.)"}</p>
              </section>
            );
          })}
          <label className="row small" style={{ alignItems: "start", flexWrap: "nowrap" }}>
            <input id="consent" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
            <span>We consent to TitleShield processing our names, bank accounts and the property's public records to verify title and operate this escrow (Digital Personal Data Protection Act, 2023). Data stays in India.</span>
          </label>
          <ErrorNote error={error} />
          <button className="primary big" type="submit" disabled={busy || !consent}>{busy ? "Opening escrow account…" : "Open escrow account"}</button>
        </div>
      </form>
    </main>
  );
}
