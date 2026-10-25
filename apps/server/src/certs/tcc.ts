import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { isIndic, transliterate, type TitleAssessment, type TitleClearanceOutput } from "@titleshield/core";
import { config } from "../config.ts";
import { loadSigner } from "../crypto/pki.ts";

/**
 * Title Clearance Certificate / Defect Evidence Report (PDF §7). Rendered with
 * pdf-lib and signed as a PAdES/CMS detached signature with the document-signer
 * certificate, so any PDF reader shows who signed it and whether it was altered.
 */

const W = 595.28, H = 841.89, M = 46;
const INK = rgb(0.09, 0.13, 0.11), MUTED = rgb(0.38, 0.43, 0.4), LINE = rgb(0.83, 0.86, 0.84);
const GREEN = rgb(0.11, 0.45, 0.28), RED = rgb(0.7, 0.15, 0.12), AMBER = rgb(0.6, 0.37, 0.03), BAND = rgb(0.06, 0.18, 0.16);

/** Standard PDF fonts are WinAnsi: romanise Indic names and drop anything else unsupported. */
export function pdfSafe(s: unknown): string {
  let t = String(s ?? "");
  if (isIndic(t)) t = t.split(/(\([^)]*\))/).map((part) => (isIndic(part) ? transliterate(part) : part)).join("");
  return t.replace(/₹/g, "Rs. ").replace(/[–—]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/·/g, "-").replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(public doc: PDFDocument, public font: PDFFont, public bold: PDFFont, public mono: PDFFont, private footer: string) { this.newPage(); }
  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.y = H - M;
    this.page.drawText(pdfSafe(this.footer), { x: M, y: 24, size: 7, font: this.font, color: MUTED });
  }
  ensure(h: number) { if (this.y - h < 50) this.newPage(); }
  wrap(text: string, size: number, font: PDFFont, width: number): string[] {
    const words = pdfSafe(text).split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(t, size) > width && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }
  text(t: string, o: { size?: number; font?: PDFFont; color?: any; x?: number; width?: number; gap?: number } = {}) {
    const size = o.size ?? 9.5, font = o.font ?? this.font, x = o.x ?? M, width = o.width ?? W - 2 * M;
    for (const l of this.wrap(t, size, font, width)) {
      this.ensure(size + 3);
      this.page.drawText(l, { x, y: this.y - size, size, font, color: o.color ?? INK });
      this.y -= size + 3.2;
    }
    this.y -= o.gap ?? 2;
  }
  heading(t: string) {
    this.ensure(30);
    this.y -= 8;
    this.page.drawText(pdfSafe(t.toUpperCase()), { x: M, y: this.y - 9, size: 8.5, font: this.bold, color: GREEN });
    this.y -= 13;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: W - M, y: this.y }, thickness: 0.6, color: LINE });
    this.y -= 6;
  }
  row(cells: Array<{ t: string; w: number; bold?: boolean; color?: any; mono?: boolean }>, size = 8.5) {
    const wrapped = cells.map((c) => this.wrap(c.t, size, c.mono ? this.mono : c.bold ? this.bold : this.font, c.w - 6));
    const h = Math.max(...wrapped.map((w) => w.length)) * (size + 2.6) + 5;
    this.ensure(h);
    let x = M;
    cells.forEach((c, i) => {
      wrapped[i].forEach((l, j) => this.page.drawText(l, { x: x + 2, y: this.y - size - j * (size + 2.6), size, font: c.mono ? this.mono : c.bold ? this.bold : this.font, color: c.color ?? INK }));
      x += c.w;
    });
    this.y -= h;
    this.page.drawLine({ start: { x: M, y: this.y + 2 }, end: { x: W - M, y: this.y + 2 }, thickness: 0.3, color: LINE });
  }
}

export interface IssueInput {
  documentType: "TITLE_CLEARANCE_CERTIFICATE" | "TITLE_DEFECT_REPORT" | "CONDITIONAL_TITLE_REPORT";
  certificateId: string;
  output: TitleClearanceOutput;
  assessment: TitleAssessment;
  query: { stateName: string; district: string; taluk: string; village: string; surveyNumber: string; claimedOwnerName?: string | null; addressText?: string | null };
  sources: Array<{ portal: string; status: string; mode: string; fromCache: boolean }>;
  evidenceHash: string;
  issuedAt: Date;
  advocate?: { name: string; decision: string; notes: string } | null;
  findings?: Array<{ strength: string; title: string; url: string }>;
}

export async function renderAndSign(input: IssueInput): Promise<{ pdf: Buffer; signerSerial: string; signerSubject: string }> {
  const signer = loadSigner();
  const doc = await PDFDocument.create();
  doc.setTitle(`${input.documentType === "TITLE_CLEARANCE_CERTIFICATE" ? "Title Clearance Certificate" : "Title Report"} ${input.certificateId}`);
  doc.setAuthor("TitleShield (BhoomiTrust)");
  const heading = input.query.surveyNumber ? `Survey ${input.query.surveyNumber}, ${input.query.village}` : input.query.village;
  doc.setSubject(heading);
  doc.setProducer("TitleShield TCC Engine");
  doc.setCreationDate(input.issuedAt);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const a = input.assessment, o = input.output;
  const w = new Writer(doc, font, bold, mono, `${input.certificateId} - verify at ${o.certificateMetadata.verificationUrl} - SHA-256 ${o.certificateMetadata.sha256DocumentHash}`);

  // Header band
  w.page.drawRectangle({ x: 0, y: H - 92, width: W, height: 92, color: BAND });
  w.page.drawText("TITLESHIELD  -  BHOOMITRUST", { x: M, y: H - 34, size: 9, font: bold, color: rgb(0.56, 0.82, 0.75) });
  const title = input.documentType === "TITLE_CLEARANCE_CERTIFICATE" ? "Title Clearance Certificate"
    : input.documentType === "TITLE_DEFECT_REPORT" ? "Title Defect Evidence Report" : "Conditional Title Report";
  w.page.drawText(title, { x: M, y: H - 62, size: 21, font: bold, color: rgb(1, 1, 1) });
  w.page.drawText(pdfSafe(`${input.certificateId}   |   Issued ${input.issuedAt.toISOString().replace("T", " ").slice(0, 19)} UTC`), { x: M, y: H - 80, size: 8.5, font, color: rgb(0.81, 0.9, 0.87) });
  w.y = H - 112;

  // Verdict
  const vColor = a.verdict === "CLEAN_TITLE" ? GREEN : a.verdict === "REJECTED" ? RED : AMBER;
  const vText = a.verdict === "CLEAN_TITLE" ? "CLEAN TITLE" : a.verdict === "REJECTED" ? "DEFECT FOUND" : "CONDITIONAL - ADVOCATE REVIEW";
  w.page.drawRectangle({ x: W - M - 168, y: w.y - 66, width: 168, height: 66, borderColor: vColor, borderWidth: 2 });
  w.page.drawText(vText, { x: W - M - 160, y: w.y - 20, size: vText.length > 14 ? 8.5 : 12, font: bold, color: vColor });
  w.page.drawText(`${o.encumbranceClearanceScore}`, { x: W - M - 160, y: w.y - 54, size: 28, font: bold, color: vColor });
  w.page.drawText("/ 100 clearance score", { x: W - M - 112, y: w.y - 50, size: 8, font, color: MUTED });

  w.text(heading, { size: 15, font: bold, width: W - 2 * M - 180 });
  w.text([input.query.taluk, input.query.district, input.query.stateName].filter(Boolean).join(", "), { size: 10, color: MUTED, width: W - 2 * M - 180 });
  if (input.query.addressText) w.text(input.query.addressText, { size: 8.5, color: MUTED, width: W - 2 * M - 180 });
  w.text(`Owner on record: ${o.lastOwnerName || "not established (Record of Rights not provided)"}`, { size: 10, width: W - 2 * M - 180 });
  if (input.query.claimedOwnerName) w.text(`Seller as declared: ${input.query.claimedOwnerName}${a.ownerMatch ? ` (${a.ownerMatch.kind}, ${Math.round(a.ownerMatch.score * 100)}%)` : ""}`, { size: 9, color: MUTED, width: W - 2 * M - 180 });
  w.y = Math.min(w.y, H - 112 - 76);

  w.heading("Risk breakdown");
  const rb = o.riskBreakdown;
  const flag = (bad: boolean, good: string, badText: string) => ({ t: bad ? badText : good, w: 170, color: bad ? RED : GREEN, bold: true });
  w.row([{ t: "Active bank lien (EC + CERSAI)", w: W - 2 * M - 170 }, flag(rb.activeBankLienDetected, "None", "DETECTED")]);
  w.row([{ t: "Pending civil litigation (eCourts)", w: W - 2 * M - 170 }, flag(rb.activeCivilLitigationDetected, "None", `${o.pendingLitigationCount} pending`)]);
  w.row([{ t: "30-year chain of title continuous", w: W - 2 * M - 170 }, flag(!rb.chainOfTitleContinuous30Yrs, "Yes", "No / gap")]);
  w.row([{ t: "Mutation synced with sub-registrar", w: W - 2 * M - 170 }, flag(!rb.mutationSyncedWithSubRegistrar, "Yes", "Lagging")]);
  w.row([{ t: "Prohibited land category", w: W - 2 * M - 170 }, flag(rb.prohibitedLandCategory, "No", "YES")]);

  w.heading(`Deterministic rules (${a.rulesetVersion})`);
  w.text(`S = max(0, 100 - sum of deductions) x product(1 - veto). Raw score ${a.rawScore}; final ${a.score}.`, { size: 8.5, color: MUTED });
  for (const r of a.rules) {
    w.row([
      { t: r.id, w: 30, bold: true },
      { t: r.label, w: 190 },
      { t: r.hit ? (r.kind === "VETO" ? "VETO" : r.kind === "DEDUCTION" ? `-${r.weight}` : "CAP 89") : "pass", w: 50, bold: true, color: r.hit ? (r.kind === "DEDUCTION" ? AMBER : RED) : GREEN },
      { t: r.detail, w: W - 2 * M - 270 }
    ], 7.8);
  }

  if (a.liens.length) {
    w.heading("Mortgages and their releases");
    for (const l of a.liens) w.row([
      { t: l.lender, w: 140, bold: true }, { t: `${l.documentNumber} (${l.registrationDate})${l.loanReference ? ` - loan ${l.loanReference}` : ""}`, w: 170, mono: true },
      { t: l.released ? `Released: ${l.releasedBy}` : "ACTIVE - no release found", w: W - 2 * M - 310, color: l.released ? GREEN : RED }
    ], 7.8);
  }
  if (a.litigation.length) {
    w.heading("Litigation (eCourts / NJDG)");
    for (const c of a.litigation) w.row([
      { t: c.cnrNumber, w: 110, mono: true }, { t: `${c.caseType} - ${c.courtName}`, w: 170 },
      { t: `${c.petitioner} v. ${c.respondent}`, w: 120 }, { t: c.currentStatus, w: W - 2 * M - 400, color: c.pending ? RED : MUTED }
    ], 7.8);
  }

  w.heading("30-year chain of title");
  if (!a.chain.links.length) w.text("No ownership transfers found in online records.", { size: 8.5, color: MUTED });
  for (const l of a.chain.links) w.row([{ t: l.date, w: 70, mono: true }, { t: l.type, w: 80 }, { t: `${l.from}  ->  ${l.to}`, w: 230 }, { t: l.evidence.join(", "), w: W - 2 * M - 380, color: MUTED }], 7.8);
  for (const b of a.chain.breaks) w.text(`Break: ${b.problem}`, { size: 8.5, color: RED });

  if (input.advocate) {
    w.heading("Empanelled advocate review");
    w.text(`${input.advocate.name} - ${input.advocate.decision}`, { font: bold });
    if (input.advocate.notes) w.text(input.advocate.notes, { size: 9 });
  }

  const findings = input.findings ?? [];
  if (findings.length) {
    w.heading("Web evidence found (TinyFish Search + Fetch)");
    for (const f of findings.slice(0, 25)) w.row([{ t: f.strength, w: 60, bold: true, color: f.strength === "STRONG" ? RED : f.strength === "MEDIUM" ? AMBER : MUTED }, { t: f.title, w: 200 }, { t: f.url, w: W - 2 * M - 260, mono: true }], 7.4);
    w.text("STRONG = survey number and village on the same page (scored). MEDIUM = owner name and place (needs review). WEAK = shown for information only.", { size: 7.5, color: MUTED });
  }

  w.heading("Sources searched");
  for (const s of input.sources) w.row([{ t: s.portal, w: 230 }, { t: s.status, w: 100, bold: true }, { t: `${s.mode}${s.fromCache ? " (cache)" : ""}`, w: W - 2 * M - 330, color: MUTED }], 8);

  w.heading("Integrity");
  w.text(`Certificate payload SHA-256: ${o.certificateMetadata.sha256DocumentHash}`, { size: 7.8, font: mono });
  w.text(`Evidence bundle SHA-256 (WORM, ${config.WORM_RETENTION_YEARS}-year lock): ${input.evidenceHash}`, { size: 7.8, font: mono });
  w.text(`Signed by ${signer.subject} (serial ${signer.serial}), issued by ${signer.issuer}. Recorded in the hash-chained ledger and anchored hourly via RFC 3161 timestamp.`, { size: 8.5 });
  w.text(`Verify: ${o.certificateMetadata.verificationUrl}`, { size: 9, font: bold });
  w.text("This report is generated from public records available online at the time of search and is not legal advice. Records not digitised online, unregistered agreements and physical possession are outside its scope.", { size: 7.5, color: MUTED });

  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: `${title} ${input.certificateId}`,
    contactInfo: "verify@titleshield.in",
    name: signer.subject,
    location: "Mumbai, IN",
    signatureLength: 16384
  });
  const unsigned = Buffer.from(await doc.save({ useObjectStreams: false }));
  const signed = await new SignPdf().sign(unsigned, new P12Signer(signer.p12, { passphrase: config.SIGNER_P12_PASSWORD }));
  return { pdf: Buffer.from(signed), signerSerial: signer.serial, signerSubject: signer.subject };
}
