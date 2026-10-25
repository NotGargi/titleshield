import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useApp } from "../App.tsx";
import { MapView } from "./MapView.tsx";

export interface LocationValue {
  addressText: string;
  stateCode: string;
  district: string;
  taluk: string;
  village: string;
  locality: string;
  pincode: string;
  surveyNumber: string;
  subDivisionHissa: string;
  latitude: number | null;
  longitude: number | null;
}

export const EMPTY_LOCATION: LocationValue = { addressText: "", stateCode: "", district: "", taluk: "", village: "", locality: "", pincode: "", surveyNumber: "", subDivisionHissa: "", latitude: null, longitude: null };

interface Resolved { stateCode: string | null; district: string | null; taluk: string | null; village: string | null; locality: string | null; pincode: string | null; lat: number | null; lon: number | null; displayName: string | null; sources: string[]; warnings: string[]; postOffices: string[] }

/**
 * Address-first location entry: type any Indian address (suggestions from OpenStreetMap),
 * find it on the map, or click the map. State, district, taluk, village and PIN fill in
 * from OpenStreetMap and India Post, and stay editable.
 */
export function LocationPicker({ value, onChange }: { value: LocationValue; onChange: (v: LocationValue) => void }) {
  const { meta } = useApp();
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{ sources: string[]; warnings: string[]; display: string | null } | null>(null);
  const timer = useRef<number | null>(null);
  const v = value;
  const set = (patch: Partial<LocationValue>) => onChange({ ...v, ...patch });
  const st = meta?.states.find((s) => s.code === v.stateCode);
  const h = st?.hierarchy ?? ["District", "Taluk / Tehsil / Mandal", "Village", "Survey / Khasra no."];

  const apply = (r: Resolved, keepTyped = true) => {
    const pick = (typed: string, found: string | null) => (keepTyped && typed.trim() ? typed : found ?? "");
    onChange({
      ...v,
      stateCode: pick(v.stateCode, r.stateCode), district: pick(v.district, r.district), taluk: pick(v.taluk, r.taluk),
      village: pick(v.village, r.village), locality: pick(v.locality, r.locality), pincode: pick(v.pincode, r.pincode),
      latitude: r.lat ?? v.latitude, longitude: r.lon ?? v.longitude
    });
    setInfo({ sources: r.sources, warnings: r.warnings, display: r.displayName });
  };

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    const text = v.addressText.trim();
    if (text.length < 4) { setSuggestions([]); return; }
    timer.current = window.setTimeout(() => {
      api(`/geo/suggest?q=${encodeURIComponent(text)}`).then((s) => setSuggestions(s)).catch(() => setSuggestions([]));
    }, 450);
  }, [v.addressText]);

  async function locate() {
    setBusy(true);
    try {
      const r = await api<Resolved>("/geo/resolve", { body: { addressText: v.addressText, stateCode: v.stateCode || null, district: v.district || null, taluk: v.taluk || null, village: v.village || null, pincode: v.pincode || null } });
      apply(r);
    } catch (e) { setInfo({ sources: [], warnings: [(e as Error).message], display: null }); }
    finally { setBusy(false); }
  }

  async function pickOnMap(lat: number, lon: number) {
    setBusy(true);
    try { apply(await api<Resolved>("/geo/reverse", { body: { lat, lon } }), false); }
    catch (e) { set({ latitude: lat, longitude: lon }); setInfo({ sources: [], warnings: [(e as Error).message], display: null }); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <label className="field">Property address
        <div className="suggest">
          <textarea id="addressText" rows={2} required value={v.addressText} placeholder="e.g. Flat 302, Prestige Shantiniketan, Whitefield, Bengaluru 560048"
            onChange={(e) => { set({ addressText: e.target.value }); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 180)} />
          {open && suggestions.length > 0 && (
            <ul className="suggest-list" role="listbox">
              {suggestions.map((s, i) => (
                <li key={i} role="option" aria-selected="false" onMouseDown={() => {
                  // Keep what the user typed (flat / building); the suggestion fills the location fields and pin.
                  onChange({ ...v, addressText: v.addressText.trim().length >= s.label.length ? v.addressText : s.label, stateCode: s.stateCode ?? v.stateCode, district: s.district ?? "", locality: s.locality ?? "", village: "", taluk: "", pincode: s.postcode ?? "", latitude: s.lat, longitude: s.lon });
                  setOpen(false); setSuggestions([]);
                }}>{s.label}</li>
              ))}
            </ul>
          )}
        </div>
      </label>
      <div className="row">
        <button type="button" onClick={locate} disabled={busy || v.addressText.trim().length < 4}>{busy ? "Finding…" : "Find on map"}</button>
        {info?.sources.length ? <span className="small muted">From {info.sources.join(" + ")}</span> : null}
      </div>
      {info?.warnings.map((w, i) => <div key={i} className="notice small">{w}</div>)}
      <MapView lat={v.latitude} lon={v.longitude} onPick={pickOnMap} />
      <div className="fields">
        <label className="field">State
          <select id="stateCode" required value={v.stateCode} onChange={(e) => set({ stateCode: e.target.value })}>
            <option value="">Choose…</option>
            {meta?.states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
        </label>
        <label className="field">{h[0]}<input id="district" required value={v.district} onChange={(e) => set({ district: e.target.value })} /></label>
        <label className="field">{h[1]}<input id="taluk" value={v.taluk} onChange={(e) => set({ taluk: e.target.value })} /></label>
        <label className="field">{h[2]} / locality<input id="village" required value={v.village} onChange={(e) => set({ village: e.target.value })} /></label>
        <label className="field">PIN code<input id="pincode" inputMode="numeric" maxLength={6} value={v.pincode} onChange={(e) => set({ pincode: e.target.value.replace(/\D/g, "") })} /></label>
        <label className="field">{h[3]} <span className="muted">(optional)</span><input id="surveyNumber" value={v.surveyNumber} onChange={(e) => set({ surveyNumber: e.target.value })} placeholder="on the sale deed or tax receipt" /></label>
      </div>
      <p className="hint">The survey number sharpens every check. It is on the sale deed, the property tax receipt, or the RTC/7-12. Without it, checks run on the owner's name and locality.</p>
    </div>
  );
}
