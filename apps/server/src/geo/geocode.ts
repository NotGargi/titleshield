import crypto from "node:crypto";
import { STATES, resolveAddress, stateCodeFromName } from "@titleshield/core";
import { config } from "../config.ts";
import { one, q } from "../db/pool.ts";

/**
 * Free location services:
 *  - Photon (komoot, OpenStreetMap)   address autocomplete as you type
 *  - Nominatim (OpenStreetMap)        address → coordinates + admin hierarchy, and reverse (map click)
 *  - India Post PIN code API          PIN → district, sub-district (block/taluk), post offices
 * Nominatim's policy: ≤ 1 request/second, identifying User-Agent, no autocomplete — respected here.
 */

export interface Suggestion { label: string; lat: number; lon: number; stateCode: string | null; state: string | null; district: string | null; locality: string | null; postcode: string | null }

export interface ResolvedLocation {
  stateCode: string | null;
  stateName: string | null;
  district: string | null;
  taluk: string | null;
  village: string | null;
  locality: string | null;
  pincode: string | null;
  lat: number | null;
  lon: number | null;
  displayName: string | null;
  postOffices: string[];
  sources: string[];
  warnings: string[];
}

const ua = () => ({ "User-Agent": config.GEO_USER_AGENT, "Accept-Language": "en", Accept: "application/json" });
const ck = (k: string) => crypto.createHash("sha256").update(k).digest("hex");

async function cached<T>(kind: string, k: string, hours: number, fn: () => Promise<T>): Promise<T> {
  const key = ck(kind + k);
  const hit = await one("SELECT response FROM web_cache WHERE cache_key = $1 AND created_at > NOW() - ($2 || ' hours')::interval", [key, String(hours)]).catch(() => null);
  if (hit) return hit.response as T;
  const v = await fn();
  await q(`INSERT INTO web_cache (cache_key, kind, request, response) VALUES ($1,$2,$3,$4) ON CONFLICT (cache_key) DO UPDATE SET response = EXCLUDED.response, created_at = NOW()`,
    [key, kind, JSON.stringify({ k }), JSON.stringify(v)]).catch(() => {});
  return v;
}

let lastNominatim = 0;
async function nominatim(path: string, params: Record<string, string>) {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const url = new URL(`${config.NOMINATIM_URL.replace(/\/$/, "")}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: ua(), signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`OpenStreetMap geocoder HTTP ${r.status}`);
  return r.json();
}

const clean = (s: unknown) => (typeof s === "string" && s.trim() ? s.trim() : null);
const stripDistrict = (s: string | null) => (s ? s.replace(/\s+(district|dist\.?)$/i, "").trim() : null);

export async function suggest(text: string): Promise<Suggestion[]> {
  if (text.trim().length < 3) return [];
  return cached("photon", text.toLowerCase().trim(), 72, async () => {
    const url = new URL(`${config.PHOTON_URL.replace(/\/$/, "")}/api/`);
    url.searchParams.set("q", text);
    url.searchParams.set("limit", "8");
    url.searchParams.set("lang", "en");
    url.searchParams.set("bbox", "68.0,6.5,97.5,37.2");
    const r = await fetch(url, { headers: ua(), signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`Address suggestions HTTP ${r.status}`);
    const j: any = await r.json();
    return (j.features ?? []).filter((f: any) => (f.properties?.countrycode ?? "").toUpperCase() === "IN").map((f: any) => {
      const p = f.properties ?? {};
      const parts = [p.name, p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street, p.locality, p.district, p.city, p.county, p.state, p.postcode].filter(Boolean);
      return {
        label: [...new Set(parts)].join(", "),
        lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0],
        stateCode: stateCodeFromName(p.state), state: p.state ?? null,
        district: stripDistrict(clean(p.county) ?? clean(p.city)), locality: clean(p.district) ?? clean(p.locality) ?? clean(p.name),
        postcode: clean(p.postcode)
      } as Suggestion;
    }).slice(0, 6);
  });
}

// ISO 3166-2:IN codes that differ from the vehicle-style codes used here.
const ISO_FIX: Record<string, string> = { OR: "OD", TG: "TS", UT: "UK", CT: "CG", DH: "DN", DD: "DN" };
function isoToCode(iso: unknown): string | null {
  if (typeof iso !== "string" || !iso.startsWith("IN-")) return null;
  const c = iso.slice(3);
  const code = ISO_FIX[c] ?? c;
  return STATES[code] ? code : null;
}

function fromNominatim(hit: any): Partial<ResolvedLocation> {
  const a = hit?.address ?? {};
  return {
    stateName: clean(a.state),
    stateCode: stateCodeFromName(a.state) ?? isoToCode(a["ISO3166-2-lvl4"]),
    district: stripDistrict(clean(a.state_district) ?? clean(a.county) ?? clean(a.city)),
    taluk: clean(a.county) && clean(a.state_district) ? clean(a.county) : clean(a.city_district) ?? clean(a.municipality),
    village: clean(a.village) ?? clean(a.hamlet) ?? clean(a.suburb) ?? clean(a.town) ?? clean(a.neighbourhood),
    locality: clean(a.suburb) ?? clean(a.neighbourhood) ?? clean(a.quarter) ?? clean(a.residential),
    pincode: clean(a.postcode)?.replace(/\s/g, "") ?? null,
    lat: hit?.lat ? Number(hit.lat) : null,
    lon: hit?.lon ? Number(hit.lon) : null,
    displayName: clean(hit?.display_name)
  };
}

export async function geocode(text: string): Promise<Partial<ResolvedLocation> | null> {
  return cached("nominatim", text.toLowerCase().trim(), 168, async () => {
    const j: any = await nominatim("search", { q: text, format: "jsonv2", addressdetails: "1", countrycodes: "in", limit: "1" });
    return Array.isArray(j) && j[0] ? fromNominatim(j[0]) : null;
  });
}

export async function reverse(lat: number, lon: number): Promise<Partial<ResolvedLocation> | null> {
  return cached("nominatim-rev", `${lat.toFixed(5)},${lon.toFixed(5)}`, 168, async () => {
    const j: any = await nominatim("reverse", { lat: String(lat), lon: String(lon), format: "jsonv2", addressdetails: "1", zoom: "18" });
    return j && !j.error ? fromNominatim(j) : null;
  });
}

export async function pincodeInfo(pin: string): Promise<{ district: string | null; taluk: string | null; state: string | null; postOffices: string[] } | null> {
  if (!/^\d{6}$/.test(pin)) return null;
  return cached("pincode", pin, 720, async () => {
    const r = await fetch(`${config.PINCODE_URL.replace(/\/$/, "")}/pincode/${pin}`, { headers: ua(), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`India Post PIN lookup HTTP ${r.status}`);
    const j: any = await r.json();
    const po = Array.isArray(j) ? j[0] : null;
    if (!po || po.Status !== "Success" || !po.PostOffice?.length) return null;
    const first = po.PostOffice[0];
    const block = po.PostOffice.map((p: any) => p.Block).find((b: string) => b && b !== "NA") ?? null;
    return { district: clean(first.District), taluk: block, state: clean(first.State), postOffices: po.PostOffice.map((p: any) => p.Name) };
  });
}

/**
 * Merge what the user typed with the geocoder and India Post. What the user entered
 * always wins; services only fill gaps. Works for any address in India.
 */
export async function resolveLocation(input: {
  addressText?: string | null; stateCode?: string | null; district?: string | null; taluk?: string | null; village?: string | null;
  locality?: string | null; pincode?: string | null; lat?: number | null; lon?: number | null;
}): Promise<ResolvedLocation> {
  const sources: string[] = [], warnings: string[] = [];
  const parsed = input.addressText ? resolveAddress(input.addressText) : null;
  const pinInText = input.addressText?.match(/\b(\d{6})\b/)?.[1] ?? null;

  let geo: Partial<ResolvedLocation> | null = null;
  try {
    if (input.lat != null && input.lon != null) { geo = await reverse(input.lat, input.lon); if (geo) sources.push("OpenStreetMap (map pin)"); }
    if (!geo && input.addressText) { geo = await geocode(input.addressText); if (geo) sources.push("OpenStreetMap (address)"); }
    if (!geo && input.addressText) warnings.push("The address was not found on OpenStreetMap; using the details you entered.");
  } catch (e) { warnings.push(`Map lookup unavailable: ${(e as Error).message}`); }

  const pincode = input.pincode?.trim() || geo?.pincode || pinInText || null;
  let pin: Awaited<ReturnType<typeof pincodeInfo>> = null;
  if (pincode) {
    try { pin = await pincodeInfo(pincode); if (pin) sources.push("India Post (PIN code)"); else warnings.push(`PIN code ${pincode} not found in India Post records.`); }
    catch (e) { warnings.push(`PIN code lookup unavailable: ${(e as Error).message}`); }
  }

  const stateCode = (input.stateCode && STATES[input.stateCode] ? input.stateCode : null) ?? geo?.stateCode ?? stateCodeFromName(pin?.state) ?? parsed?.stateCode ?? null;
  const pick = (...v: Array<string | null | undefined>) => v.map((x) => (x ?? "").trim()).find((x) => x.length > 0) || null;
  return {
    stateCode,
    stateName: stateCode ? STATES[stateCode]?.name ?? null : geo?.stateName ?? pin?.state ?? null,
    district: pick(input.district, geo?.district, pin?.district, parsed?.district),
    taluk: pick(input.taluk, pin?.taluk, geo?.taluk, parsed?.taluk),
    village: pick(input.village, geo?.village, input.locality, geo?.locality, pin?.postOffices[0], parsed?.village),
    locality: pick(input.locality, geo?.locality, geo?.village),
    pincode,
    lat: input.lat ?? geo?.lat ?? null,
    lon: input.lon ?? geo?.lon ?? null,
    displayName: geo?.displayName ?? null,
    postOffices: pin?.postOffices ?? [],
    sources,
    warnings
  };
}
