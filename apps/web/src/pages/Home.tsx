import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.ts";
import { useApp } from "../App.tsx";
import { ErrorNote } from "../components/ui.tsx";
import { EMPTY_LOCATION, LocationPicker, type LocationValue } from "../components/LocationPicker.tsx";
import { RecordsUpload, uploadDocs, type PendingDoc } from "../components/RecordsUpload.tsx";

export function locationBody(loc: LocationValue) {
  return {
    addressText: loc.addressText || null, stateCode: loc.stateCode || null, district: loc.district || null, taluk: loc.taluk || null,
    village: loc.village || null, locality: loc.locality || null, pincode: loc.pincode || null, surveyNumber: loc.surveyNumber || null,
    subDivisionHissa: loc.subDivisionHissa || null, latitude: loc.latitude, longitude: loc.longitude
  };
}

export function HomePage() {
  const { meta, user } = useApp();
  const nav = useNavigate();
  const [loc, setLoc] = useState<LocationValue>(EMPTY_LOCATION);
  const [owner, setOwner] = useState("");
  const [docs, setDocs] = useState<PendingDoc[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return nav("/login?next=/");
    setBusy(true); setError(null);
    try {
      const r = await api("/title-search/execute", { body: { ...locationBody(loc), claimedOwnerName: owner || null, streamProgress: false, startImmediately: docs.length === 0 } });
      if (docs.length) {
        await uploadDocs(r.searchId, docs);
        await api(`/title-search/${r.searchId}/start`, { body: {} });
      }
      nav(`/search/${r.searchId}`);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return (
    <main>
      <section className="hero">
        <div className="eyebrow">30-year title search · encumbrance check · escrow</div>
        <h1>Is this property safe to buy?</h1>
        <p>Enter any address in India. TitleShield finds it on the map, then checks court records, bank notices and government notifications with TinyFish's free Search and Fetch. It reads the owner's EC and Record of Rights, applies fixed rules, and issues a digitally signed report.</p>
      </section>

      <form className="split" onSubmit={submit}>
        <section className="card" aria-labelledby="propH">
          <div className="card-head"><h2 id="propH">1 · Property</h2></div>
          <LocationPicker value={loc} onChange={setLoc} />
        </section>

        <div className="stack">
          <section className="card" aria-labelledby="ownerH">
            <h2 id="ownerH">2 · Owner</h2>
            <label className="field">Seller's full name, as on the documents
              <input id="owner" required value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. Venkatesh Murthy" />
            </label>
            <p className="hint">Used to search court cases and bank notices, and matched against the owner on the Record of Rights in any script.</p>
          </section>

          <section className="card" aria-labelledby="recH">
            <div className="card-head"><h2 id="recH">3 · Official records</h2><span className="pill">{docs.length ? `${docs.length} added` : "recommended"}</span></div>
            <RecordsUpload stateCode={loc.stateCode} docs={docs} onChange={setDocs} />
            <p className="hint">Without the EC and RoR the web checks still run, but the report cannot certify a clean title; it goes to an advocate instead.</p>
          </section>

          <ErrorNote error={error} />
          {meta && !meta.tinyfish.configured && <div className="notice small">Web checks need a free TinyFish key. <Link to="/settings">Add it in Settings</Link> — it takes a minute and needs no card.</div>}
          <button className="primary big" type="submit" disabled={busy}>{busy ? "Starting…" : user ? "Run title search" : "Sign in to run the search"}</button>
          <p className="hint">Paying an advance? <Link to="/escrow/new">Hold it in escrow</Link> and it's released only if the title is clean.</p>
        </div>
      </form>
    </main>
  );
}
