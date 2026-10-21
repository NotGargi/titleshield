import { api } from "../api.ts";
import { useApp } from "../App.tsx";

export interface PendingDoc { file: File; kind: "EC" | "ROR" | "SALE_DEED" | "COURT" }

const KINDS: Array<{ kind: PendingDoc["kind"]; label: string; hint: string }> = [
  { kind: "EC", label: "Encumbrance Certificate (EC)", hint: "Every registered sale, mortgage and release" },
  { kind: "ROR", label: "Record of Rights (RTC / 7-12 / Khatauni / Patta)", hint: "Current owner and government restrictions" },
  { kind: "SALE_DEED", label: "Sale deed", hint: "Optional" }
];

export async function uploadDocs(searchId: string, docs: PendingDoc[]) {
  for (const d of docs) {
    const fd = new FormData();
    fd.append("kind", d.kind);
    fd.append("file", d.file);
    await api(`/title-search/${searchId}/documents`, { form: fd });
  }
}

/** Pick the owner's official records. Shows where to download them for the chosen state. */
export function RecordsUpload({ stateCode, docs, onChange }: { stateCode: string; docs: PendingDoc[]; onChange: (d: PendingDoc[]) => void }) {
  const { meta } = useApp();
  const st = meta?.states.find((s) => s.code === stateCode);
  return (
    <div className="stack">
      <p className="small muted">
        The EC and RoR sit behind the owner's login, OTP or CAPTCHA on the state portal, so the owner downloads them and adds them here.
        {meta?.documentAi ? ` They are read by ${meta.documentAi} in any Indian language.` : " Digital PDFs are read directly; add a free Gemini key in Settings to also read scans and photos."}
      </p>
      {st && (
        <div className="portal-links">
          {st.encumbrancePortal && <a href={st.encumbrancePortal.url} target="_blank" rel="noreferrer">Get the EC: {st.encumbrancePortal.name} ↗</a>}
          {st.revenuePortal && <a href={st.revenuePortal.url} target="_blank" rel="noreferrer">Get the RoR: {st.revenuePortal.name} ↗</a>}
          {!st.encumbrancePortal && !st.revenuePortal && <span className="small muted">{st.name} has no single statewide portal registered here; the search will look one up.</span>}
        </div>
      )}
      {KINDS.map((k) => {
        const have = docs.filter((d) => d.kind === k.kind);
        return (
          <div key={k.kind} className="doc-row">
            <div><b className="small">{k.label}</b><div className="hint">{k.hint}</div></div>
            <label className="btn small-btn">
              {have.length ? "Add another" : "Choose file"}
              <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" hidden onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onChange([...docs, { file: f, kind: k.kind }]);
                e.target.value = "";
              }} />
            </label>
            {have.map((d, i) => (
              <div key={i} className="doc-chip"><span>{d.file.name}</span><button type="button" className="link" onClick={() => onChange(docs.filter((x) => x !== d))}>Remove</button></div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
