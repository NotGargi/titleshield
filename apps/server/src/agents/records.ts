import { STATES } from "@titleshield/core";
import { one, q } from "../db/pool.ts";
import { publish } from "../events/bus.ts";
import { getObject } from "../storage/worm.ts";
import { extractWithGemini, geminiConfigured, type DocKind } from "../docai/gemini.ts";
import { extractWithoutAi } from "../docai/pdftext.ts";
import type { AgentOutcome } from "./webAgents.ts";

/**
 * RECORDS agent: the owner's official records — Encumbrance Certificate and Record of
 * Rights downloaded from the state portal (which needs the owner's login / OTP / CAPTCHA),
 * plus sale deeds and court orders. Read with Gemini when a key is saved, otherwise
 * from the PDF's text layer.
 */
export async function runRecordsAgent(searchId: string): Promise<AgentOutcome> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const s = await one("SELECT state_code, survey_number FROM title_searches WHERE search_id = $1", [searchId]);
  const st = STATES[s.state_code];
  const say = (step: string) => publish(searchId, "tinyfish_progress", { portal: "OWNER_DOCUMENTS", role: "RECORDS", step, elapsedMs: elapsed() });
  await publish(searchId, "tinyfish_started", { portal: "OWNER_DOCUMENTS", role: "RECORDS", name: "Official records (EC, RoR, deeds)", mode: "documents" });
  const run = await one<{ run_id: string }>(`INSERT INTO tinyfish_agent_runs (search_id, portal_code, goal_prompt_version, status, agent_role, mode) VALUES ($1,'OWNER_DOCUMENTS','DOC_READER_V1','STREAMING','RECORDS','documents') RETURNING run_id`, [searchId]);

  const docs = await q("SELECT * FROM documents WHERE search_id = $1 AND status IN ('UPLOADED','FAILED') ORDER BY created_at", [searchId]);
  const useAi = await geminiConfigured();
  let ok = 0, failed = 0;
  const messages: string[] = [];
  if (!docs.length) {
    await say(`No records uploaded. Download the EC from ${st?.encumbrance?.name ?? "the state registration portal"} and the RoR from ${st?.revenue?.name ?? "the state land-records portal"} to certify the title.`);
  }
  for (const d of docs) {
    await say(`Reading ${d.filename} (${d.kind}) ${useAi ? "with Gemini" : "from the PDF text"}`);
    try {
      const data = await getObject(d.storage_uri);
      const args = { data, mimeType: d.mime_type, kind: d.kind as DocKind, surveyNumber: s.survey_number ?? "" };
      const r = useAi ? await extractWithGemini(args) : await extractWithoutAi(args);
      const x = r.extraction;
      const rows = x.encumbrances.length + x.mutationHistory.length + x.currentOwnerNames.length + x.litigationCases.length;
      await q("UPDATE documents SET status = 'EXTRACTED', extracted_json = $2, pages = $3, language = $4, error = NULL WHERE document_id = $1",
        [d.document_id, JSON.stringify(x), r.pages, r.vernacular.scripts.join(",")]);
      ok++;
      const msg = `${d.filename}: ${x.encumbrances.length} transactions, ${x.currentOwnerNames.length} owner name(s), ${x.mutationHistory.length} mutations${r.vernacular.legacyFontFields.length ? `, ${r.vernacular.legacyFontFields.length} legacy-font fields decoded` : ""}`;
      messages.push(msg);
      await say(rows ? msg : `${d.filename}: no rows recognised — check it is the right document`);
    } catch (e) {
      failed++;
      await q("UPDATE documents SET status = 'FAILED', error = $2 WHERE document_id = $1", [d.document_id, (e as Error).message]);
      await say(`${d.filename}: ${(e as Error).message}`);
    }
  }
  const status = docs.length === 0 ? "NO_RECORD" : ok > 0 ? "SUCCESS" : "FAILED";
  await q("UPDATE tinyfish_agent_runs SET status = $2, error = $3, finished_at = NOW() WHERE run_id = $1", [run!.run_id, status, failed ? `${failed} document(s) could not be read` : null]);
  await publish(searchId, "tinyfish_agent_completed", { portal: "OWNER_DOCUMENTS", role: "RECORDS", status, elapsedMs: elapsed(), error: null, counts: { documents: docs.length, read: ok, failed } });
  return { role: "RECORDS", portalCode: "OWNER_DOCUMENTS", portalName: "Official records", status: status as AgentOutcome["status"], extraction: null, findings: [], durationMs: elapsed(), error: null, evidenceUri: null, evidenceSha256: null };
}
