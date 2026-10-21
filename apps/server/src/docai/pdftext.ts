import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { normalizeAgentResult, parseEcText, parseRorText, type PortalCode, type PortalExtraction } from "@titleshield/core";
import { normalizeVernacular, type VernacularReport } from "./vernacular.ts";
import { DOC_KINDS, type DocKind } from "./gemini.ts";

/**
 * Document reading without any API: pulls the text layer out of a digital PDF
 * (most ECs downloaded from Kaveri, TNREGINET, IGRS, IGR Maharashtra are digital)
 * and parses it with the deterministic EC / RoR parsers. Scans and photos have no
 * text layer and need the Gemini reader.
 */

export async function pdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true, isEvalSupported: false }).promise;
  let text = "";
  for (let i = 1; i <= Math.min(doc.numPages, 60); i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map((it: any) => (it.str ?? "") + (it.hasEOL ? "\n" : " ")).join("") + "\n";
  }
  await doc.destroy();
  return { text, pages: doc.numPages };
}

export async function extractWithoutAi(opts: { data: Buffer; mimeType: string; kind: DocKind; surveyNumber: string }): Promise<{ extraction: PortalExtraction; vernacular: VernacularReport; pages: number; rows: number }> {
  if (opts.mimeType !== "application/pdf") throw new Error("Photos and scans need the Gemini reader. Add a free Gemini key on the Settings page, or upload the digital PDF from the portal.");
  const { text, pages } = await pdfText(opts.data);
  if (text.replace(/\s/g, "").length < 40) throw new Error("This PDF has no text layer (it is a scan). Add a free Gemini key on the Settings page to read scans.");
  const base: any = { portalStatus: "OK", surveyNumberMatched: (text.match(/(?:survey|sy\.?|khasra|gat)\s*(?:no\.?|number)?\s*[:\-]?\s*([0-9][0-9A-Za-z\/\-]*)/i) ?? [])[1] ?? opts.surveyNumber,
    currentOwnerNames: [], mutationHistory: [], encumbrances: [], litigationCases: [], rawArtifactUrls: [] };
  let rows = 0;
  if (opts.kind === "EC" || opts.kind === "SALE_DEED") {
    const ec = parseEcText(text);
    base.encumbrances = ec.entries; base.ecCoverageFromYear = ec.coverageFromYear; rows = ec.entries.length;
  }
  if (opts.kind === "ROR") {
    const r = parseRorText(text);
    base.currentOwnerNames = r.owners; base.otherRightsAndLiabilities = r.liabilities; base.landExtent = r.extent; rows = r.owners.length;
  }
  const parsed = normalizeAgentResult(DOC_KINDS[opts.kind].portal as PortalCode, base, opts.surveyNumber);
  const { extraction, report } = normalizeVernacular(parsed);
  return { extraction, vernacular: report, pages, rows };
}
