import { Client, Connection } from "@temporalio/client";
import { config } from "../config.ts";
import { q } from "../db/pool.ts";
import * as acts from "./activities.ts";
import { finalizeSaga, titleSearchSaga, type SagaEnv } from "./logic.ts";

/**
 * Workflow engine switch.
 *  WORKFLOW_ENGINE=temporal → durable Temporal workflows (docker-compose / production).
 *  WORKFLOW_ENGINE=inline   → the same saga in-process with activity retries; no extra services.
 */

let temporalClient: Client | null = null;
async function temporal() {
  if (temporalClient) return temporalClient;
  const connection = await Connection.connect({ address: config.TEMPORAL_ADDRESS });
  temporalClient = new Client({ connection, namespace: config.TEMPORAL_NAMESPACE });
  return temporalClient;
}

function withRetry<T extends (...args: any[]) => Promise<any>>(fn: T, attempts = 3): T {
  return (async (...args: any[]) => {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(...args); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 500 * 2 ** i)); }
    }
    throw last;
  }) as T;
}

const inlineEnv: SagaEnv = {
  acts: {
    beginSearch: withRetry(acts.beginSearch), resolveLocationStep: withRetry(acts.resolveLocationStep, 2), runAgent: withRetry(acts.runAgent, 2), note: acts.note,
    documentIntelligence: withRetry(acts.documentIntelligence), scoreTitle: withRetry(acts.scoreTitle),
    openAdvocateReview: withRetry(acts.openAdvocateReview), issueCertificate: withRetry(acts.issueCertificate, 2),
    settleEscrow: withRetry(acts.settleEscrow, 4), startMonitoring: withRetry(acts.startMonitoring),
    notifyTenant: acts.notifyTenant, failSearch: acts.failSearch
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  awaitAdvocateDecision: async () => null,
  onMonitoringStarted: async () => { /* the inline scheduler picks up due subscriptions */ }
};

export async function startTitleSearch(searchId: string) {
  const workflowId = `title-search-${searchId}`;
  await q("UPDATE title_searches SET workflow_id = $2 WHERE search_id = $1", [searchId, workflowId]);
  if (config.WORKFLOW_ENGINE === "temporal") {
    const c = await temporal();
    await c.workflow.start("titleSearchWorkflow", { taskQueue: config.TEMPORAL_TASK_QUEUE, workflowId, args: [searchId] });
    return { engine: "temporal", workflowId };
  }
  void titleSearchSaga(inlineEnv, searchId).catch((e) => console.error(`search ${searchId} failed:`, e));
  return { engine: "inline", workflowId };
}

/** Advocate decision already stored in advocate_reviews; resume the saga. */
export async function resumeAfterAdvocate(searchId: string, decision: "APPROVE" | "REJECT") {
  if (config.WORKFLOW_ENGINE === "temporal") {
    const c = await temporal();
    await c.workflow.getHandle(`title-search-${searchId}`).signal("advocateDecision", decision);
    return;
  }
  void finalizeSaga(inlineEnv, searchId).catch(async (e) => { console.error(e); await acts.failSearch(searchId, (e as Error).message); });
}

/** Inline scheduler for continuous monitoring (Temporal runs escrowMonitorWorkflow instead). */
let monitorTimer: NodeJS.Timeout | null = null;
export function startInlineScheduler() {
  if (config.WORKFLOW_ENGINE !== "inline" || monitorTimer) return;
  monitorTimer = setInterval(async () => {
    try {
      const due = await q(`SELECT subscription_id FROM monitor_subscriptions WHERE active AND until_date >= CURRENT_DATE
                           AND (last_run_at IS NULL AND created_at < NOW() - (interval_minutes || ' minutes')::interval
                                OR last_run_at < NOW() - (interval_minutes || ' minutes')::interval)`);
      for (const d of due) await acts.runMonitorCheck(d.subscription_id);
    } catch (e) { console.error("monitor scheduler", e); }
  }, 60_000);
  monitorTimer.unref();
}

export function stopInlineScheduler() { if (monitorTimer) clearInterval(monitorTimer); monitorTimer = null; }
