import { useEffect, useState } from "react";
import { isIndic } from "../api.ts";

export function StatusPill({ status }: { status: string | null | undefined }) {
  const s = status ?? "";
  const map: Record<string, [string, string]> = {
    QUEUED: ["", "Queued"], RUNNING_TINYFISH: ["run", "Agents running"], OCR_PARSING: ["run", "Reading records"], SCORING: ["run", "Scoring"],
    COMPLETED: ["ok", "Completed"], FAILED: ["bad", "Failed"], MANUAL_REVIEW: ["warn", "Advocate review"],
    SUCCESS: ["ok", "Done"], NO_RECORD: ["warn", "Not enough details"], NOT_CONFIGURED: ["warn", "Needs TinyFish key"], RATE_LIMITED: ["warn", "Free limit reached"], EXTRACTED: ["ok", "Read"], UPLOADED: ["", "Uploaded"], PORTAL_DOWN: ["bad", "Portal down"], CAPTCHA_BLOCKED: ["bad", "Blocked"], TIMEOUT: ["bad", "Timed out"], STREAMING: ["run", "Running"],
    CLEAN_TITLE: ["ok", "Clean title"], CONDITIONAL_REVIEW: ["warn", "Conditional"], REJECTED: ["bad", "Defect found"],
    AWAITING_DEPOSIT: ["", "Awaiting deposit"], FUNDS_LOCKED: ["run", "Funds locked"], VERIFICATION_IN_PROGRESS: ["run", "Verifying"],
    RELEASED_TO_SELLER: ["ok", "Released to seller"], REFUNDED_TO_BUYER: ["bad", "Refunded to buyer"], DISPUTE_HOLD: ["warn", "On hold"]
  };
  const [cls, label] = map[s] ?? ["", s.replace(/_/g, " ").toLowerCase()];
  return <span className={`pill ${cls}`}>{cls === "run" && <span className="dot pulse" />}{label}</span>;
}

/** Shows a name in its original script with the romanised form underneath when they differ. */
export function Name({ value, latin }: { value: string; latin?: string }) {
  if (!value) return <span className="muted">—</span>;
  return isIndic(value)
    ? <span><span className="indic">{value}</span>{latin && <span className="muted small"> · {latin}</span>}</span>
    : <span>{value}</span>;
}

export function Gauge({ score, verdict }: { score: number; verdict: string }) {
  const r = 62, c = 2 * Math.PI * r;
  const col = verdict === "CLEAN_TITLE" ? "var(--ok)" : verdict === "CONDITIONAL_REVIEW" ? "var(--warn)" : "var(--bad)";
  return (
    <div className="gauge">
      <svg viewBox="0 0 160 160" role="img" aria-label={`Clearance score ${score} out of 100`}>
        <circle cx="80" cy="80" r={r} fill="none" stroke="var(--line)" strokeWidth="13" />
        {score > 0 && <circle cx="80" cy="80" r={r} fill="none" stroke={col} strokeWidth="13" strokeLinecap="round" strokeDasharray={`${(c * score) / 100} ${c}`} transform="rotate(-90 80 80)" />}
        <text x="80" y="84" textAnchor="middle" fontFamily="Fraunces, Georgia, serif" fontSize="44" fontWeight="650" fill="var(--ink)">{score}</text>
        <text x="80" y="108" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="var(--muted)">out of 100</text>
      </svg>
      <StatusPill status={verdict} />
    </div>
  );
}

export function useElapsed(startIso: string | null, stopIso: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startIso || stopIso) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [startIso, stopIso]);
  if (!startIso) return 0;
  return ((stopIso ? Date.parse(stopIso) : now) - Date.parse(startIso)) / 1000;
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <div className="form-error" role="alert">{error}</div> : null;
}

export function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="link small" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ }
    }}>{done ? "Copied" : "Copy"}</button>
  );
}
