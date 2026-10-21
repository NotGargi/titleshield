/**
 * Temporal workflow definitions (PDF §2: "Temporal.io manages 60 s saga workflows,
 * retries, parallel fan-out, state transitions & escrow triggers").
 * Runs inside Temporal's deterministic sandbox: only @temporalio/workflow and the
 * import-free saga logic are used here.
 */
import { condition, defineSignal, proxyActivities, setHandler, sleep, startChild, ParentClosePolicy } from "@temporalio/workflow";
import type * as A from "../activities.ts";
import { titleSearchSaga } from "../logic.ts";

const agents = proxyActivities<typeof A>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 2, initialInterval: "5s" }
});
const steps = proxyActivities<typeof A>({
  startToCloseTimeout: "3 minutes",
  retry: { maximumAttempts: 4, initialInterval: "2s", backoffCoefficient: 2 }
});
// Money movement is idempotent per escrow leg, so it may be retried safely.
const money = proxyActivities<typeof A>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 5, initialInterval: "3s", backoffCoefficient: 2 }
});

export const advocateDecisionSignal = defineSignal<["APPROVE" | "REJECT"]>("advocateDecision");

export async function titleSearchWorkflow(searchId: string) {
  let decision: "APPROVE" | "REJECT" | null = null;
  setHandler(advocateDecisionSignal, (d) => { decision = d; });
  return titleSearchSaga({
    acts: {
      beginSearch: steps.beginSearch, resolveLocationStep: steps.resolveLocationStep, runAgent: agents.runAgent, note: steps.note, documentIntelligence: steps.documentIntelligence,
      scoreTitle: steps.scoreTitle, openAdvocateReview: steps.openAdvocateReview, issueCertificate: steps.issueCertificate,
      settleEscrow: money.settleEscrow, startMonitoring: steps.startMonitoring, notifyTenant: steps.notifyTenant, failSearch: steps.failSearch
    },
    sleep: (ms) => sleep(ms),
    awaitAdvocateDecision: async () => { await condition(() => decision !== null); return decision; },
    onMonitoringStarted: async (subscriptionId, intervalMinutes) => {
      await startChild(escrowMonitorWorkflow, {
        workflowId: `escrow-monitor-${subscriptionId}`,
        args: [subscriptionId, intervalMinutes],
        parentClosePolicy: ParentClosePolicy.ABANDON
      });
    }
  }, searchId);
}

/** TinyFish-Monitor-style continuous check until the sale deed is registered (PDF §3.4). */
export async function escrowMonitorWorkflow(subscriptionId: string, intervalMinutes: number) {
  for (let i = 0; i < 400; i++) {
    await sleep(intervalMinutes * 60_000);
    const r = await agents.runMonitorCheck(subscriptionId);
    if (!r.active) return;
  }
}
