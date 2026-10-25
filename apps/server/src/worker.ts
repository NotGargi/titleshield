import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { config } from "./config.ts";
import * as activities from "./workflows/activities.ts";
import { ensurePki } from "./crypto/pki.ts";
import { migrate } from "./db/migrate.ts";

/** Temporal worker: executes titleSearchWorkflow + escrowMonitorWorkflow (WORKFLOW_ENGINE=temporal). */
async function main() {
  await migrate();
  ensurePki();
  const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
  const worker = await Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    workflowsPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "workflows/temporal/workflows.ts"),
    activities,
    maxConcurrentActivityTaskExecutions: 500   // PDF §1.3: 500+ concurrent agent sessions
  });
  console.log(`Temporal worker on ${config.TEMPORAL_ADDRESS}, queue "${config.TEMPORAL_TASK_QUEUE}"`);
  await worker.run();
}

main().catch((e) => { console.error(e); process.exit(1); });
