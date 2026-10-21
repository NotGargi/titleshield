import type { PortalExtraction } from "./schemas.ts";
import { classifyTransaction } from "./mortgages.ts";
import { compareNames, sameParty } from "./names/resolver.ts";

/**
 * 30-year chain-of-title graph (PDF §4.1 stage 3). Builds a DAG of ownership
 * transfers from registered deeds (EC) and mutation entries (revenue record),
 * resolves party identities across spellings/scripts, and reports breaks.
 */

export interface Transfer {
  date: string;
  type: string;
  from: string;
  to: string;
  source: "EC" | "MUTATION";
  reference: string;
}

export interface ChainLink { from: string; to: string; date: string; type: string; evidence: string[] }

export interface ChainResult {
  links: ChainLink[];
  rootOwner: string | null;
  currentOwner: string | null;
  continuous: boolean;
  breaks: Array<{ owner: string; problem: string; date: string }>;
  mutationLagging: boolean;
  lagDetail: string | null;
  windowStart: string;
}

const OWNERSHIP_TYPES = new Set(["SALE", "GIFT", "PARTITION", "SETTLEMENT", "INHERITANCE", "COURT_DECREE"]);

export function collectTransfers(extractions: PortalExtraction[]): Transfer[] {
  const t: Transfer[] = [];
  for (const x of extractions) {
    for (const m of x.mutationHistory) {
      if (m.transferType === "MORTGAGE") continue;
      t.push({ date: m.mutationDate, type: m.transferType, from: m.transferor, to: m.transferee, source: "MUTATION", reference: m.mutationNumber });
    }
    for (const e of x.encumbrances) {
      const kind = classifyTransaction(e.transactionNature);
      if (!OWNERSHIP_TYPES.has(kind) || !e.executant || !e.claimant) continue;
      t.push({ date: e.registrationDate, type: kind, from: e.executant, to: e.claimant, source: "EC", reference: e.documentNumber });
    }
  }
  return t.filter((x) => x.date && x.from && x.to).sort((a, b) => a.date.localeCompare(b.date));
}

export function buildChain(extractions: PortalExtraction[], asOf = new Date(), years = 30): ChainResult {
  const windowStart = new Date(asOf);
  windowStart.setFullYear(windowStart.getFullYear() - years);
  const ws = windowStart.toISOString().slice(0, 10);
  const transfers = collectTransfers(extractions);

  // Merge EC deeds and their mutations into one link per ownership change.
  const links: ChainLink[] = [];
  for (const t of transfers) {
    const same = links.find((l) => sameParty(l.from, t.from) && sameParty(l.to, t.to)
      && Math.abs(Date.parse(l.date) - Date.parse(t.date)) < 1000 * 86400 * 365 * 2);
    if (same) {
      same.evidence.push(`${t.source} ${t.reference}`);
      if (t.source === "EC") { same.date = t.date; same.type = t.type; }
      continue;
    }
    links.push({ from: t.from, to: t.to, date: t.date, type: t.type, evidence: [`${t.source} ${t.reference}`] });
  }
  links.sort((a, b) => a.date.localeCompare(b.date));

  const recordOwners = extractions.flatMap((x) => x.portalName.startsWith("ECOURTS") || x.portalName === "CERSAI" ? [] : x.currentOwnerNames);
  const lastLink = links[links.length - 1];
  const currentOwner = lastLink?.to ?? recordOwners[0] ?? null;
  const rootOwner = links[0]?.from ?? currentOwner;

  // Every transferor (other than the root) must have acquired title earlier in the chain.
  const breaks: ChainResult["breaks"] = [];
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (i === 0) continue;
    const acquired = links.slice(0, i).some((p) => sameParty(p.to, l.from) && p.date <= l.date);
    if (!acquired) breaks.push({ owner: l.from, problem: `No registered deed or mutation shows how ${l.from} acquired title before transferring it`, date: l.date });
  }
  if (links.length && links[0].date > ws) {
    // The chain starts inside the 30-year window: the root must be shown as owner at the window start.
    const rootOnRecordEarly = extractions.some((x) => (x.ecCoverageFromYear ?? 9999) <= windowStart.getFullYear());
    if (!rootOnRecordEarly) breaks.push({ owner: links[0].from, problem: `Title of ${links[0].from} before ${links[0].date.slice(0, 4)} is not covered by online records`, date: links[0].date });
  }

  // Mutation lag: the latest registered transfer (EC) is not yet reflected in the revenue record.
  const ecTransfers = transfers.filter((t) => t.source === "EC");
  const lastDeed = ecTransfers[ecTransfers.length - 1];
  let mutationLagging = false, lagDetail: string | null = null;
  if (lastDeed) {
    const mutated = transfers.some((t) => t.source === "MUTATION" && sameParty(t.to, lastDeed.to) && t.date >= lastDeed.date.slice(0, 7));
    const recordShowsBuyer = recordOwners.some((o) => sameParty(o, lastDeed.to));
    if (!mutated && !recordShowsBuyer) {
      mutationLagging = true;
      lagDetail = `Sale deed ${lastDeed.reference} (${lastDeed.date}) to ${lastDeed.to} is not reflected in the revenue record`;
    }
  }

  return {
    links,
    rootOwner,
    currentOwner,
    continuous: breaks.length === 0,
    breaks,
    mutationLagging,
    lagDetail,
    windowStart: ws
  };
}

export function ownerMatchesClaim(claimed: string | null | undefined, recordOwner: string | null) {
  if (!claimed || !recordOwner) return null;
  return compareNames(claimed, recordOwner);
}
