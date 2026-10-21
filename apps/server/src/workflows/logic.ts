/**
 * The 60-second title-search saga (PDF §2, §6.2), written once and executed by
 * either engine. This file must stay deterministic and import-free (type-only
 * imports are erased) so Temporal can replay it inside its workflow sandbox.
 */
import type * as A from "./activities.ts";

export interface SagaEnv {
  acts: Pick<typeof A, "beginSearch" | "resolveLocationStep" | "runAgent" | "note" | "documentIntelligence" | "scoreTitle" | "openAdvocateReview" | "issueCertificate" | "settleEscrow" | "startMonitoring" | "notifyTenant" | "failSearch">;
  sleep(ms: number): Promise<void>;
  /** Temporal waits for the advocate signal; the inline engine returns null and resumes later. */
  awaitAdvocateDecision(): Promise<"APPROVE" | "REJECT" | null>;
  /** Called after a clean release: Temporal starts a child monitor workflow, inline registers a schedule. */
  onMonitoringStarted(subscriptionId: string, intervalMinutes: number): Promise<void>;
}

const ROLES = ["RECORDS", "COURTS", "BANK_NOTICES", "GOVT_NOTICES"] as const;
const RETRYABLE = ["RATE_LIMITED", "FAILED"];

export async function titleSearchSaga(env: SagaEnv, searchId: string) {
  const { acts } = env;
  try {
    const info = await acts.beginSearch(searchId);
    // Address → state / district / taluk / village / PIN / map point (district-rent-shark pattern)
    await acts.resolveLocationStep(searchId);

    // Parallel fan-out (tenders-finder pattern): official records + three free TinyFish web agents
    let outcomes = await Promise.all(ROLES.map((r) => acts.runAgent(searchId, r, info.allowCache)));

    // Circuit-broken / failed portals: B2B searches back off and retry before scoring (PDF §10.3).
    for (let attempt = 1; attempt <= info.maxPortalRetries; attempt++) {
      const failed = outcomes.filter((o) => o.role !== "RECORDS" && RETRYABLE.includes(o.status));
      if (!failed.length || info.maxPortalRetries <= 1) break;
      const delay = Math.min(10 * 60_000, 65_000 * 2 ** (attempt - 1)); // past the free per-minute window
      await acts.note(searchId, "portal_retry_scheduled", { portals: failed.map((f) => f.portal), attempt, delayMs: delay });
      await env.sleep(delay);
      const retried = await Promise.all(failed.map((f) => acts.runAgent(searchId, f.role, false)));
      outcomes = outcomes.map((o) => retried.find((r) => r.role === o.role) ?? o);
    }

    await acts.documentIntelligence(searchId, outcomes);
    const score = await acts.scoreTitle(searchId);

    if (score.verdict === "CONDITIONAL_REVIEW") {
      await acts.openAdvocateReview(searchId);
      if (info.escrowLinked) await acts.settleEscrow(searchId, "DISPUTE_HOLD", null, null, score.verdict);
      const decision = await env.awaitAdvocateDecision();
      if (decision === null) return { status: "AWAITING_ADVOCATE" as const };
    }
    return await finalizeSaga(env, searchId);
  } catch (e) {
    await acts.failSearch(searchId, (e as Error).message ?? String(e));
    throw e;
  }
}

/** Certificate → escrow settlement → monitoring → tenant webhook. */
export async function finalizeSaga(env: SagaEnv, searchId: string) {
  const { acts } = env;
  const cert = await acts.issueCertificate(searchId);
  if (cert.escrowLinked) {
    await acts.settleEscrow(searchId, cert.escrowAction, cert.certificateId, cert.evidenceHash, cert.verdict);
    if (cert.escrowAction === "RELEASE_TO_SELLER") {
      const m = await acts.startMonitoring(searchId);
      await env.onMonitoringStarted(m.subscriptionId, m.intervalMinutes);
    }
  }
  await acts.notifyTenant(searchId);
  return { status: "COMPLETED" as const, certificateId: cert.certificateId, verdict: cert.verdict };
}
