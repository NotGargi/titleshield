import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { REPO_ROOT } from "../src/config.ts";

/**
 * Specimen records for the two live walkthrough scenarios (digital PDFs with a text layer).
 * Scenario A (clean): CTS 28/4, Chandivali — owner Vihaan Rajadhyaksha; a past loan was released.
 * Scenario B (defect): CTS 112/7, Kandivali — owner Kabir Sabnis; a registered mortgage was never released.
 * They are fictional and say "Specimen" on every page.
 */
export const DEMO_EC = [
  "SEARCH REPORT / ENCUMBRANCE CERTIFICATE",
  "Office of the Sub-Registrar, Kurla, Mumbai Suburban District",
  "Property: C.T.S. No. 28/4, Village Chandivali, Taluka Kurla, District Mumbai Suburban",
  "Search period from 01-01-1995 to 15-10-2026",
  "",
  "1. Document No 2214/1998 Date 11-05-1998 Nature: Sale Deed",
  "   Executant: Dinesh Kulkarni Claimant: Meera Joshi Consideration Rs. 14,50,000",
  "2. Document No 6731/2011 Date 23-08-2011 Nature: Sale Deed",
  "   Executant: Meera Joshi Claimant: Vihaan Rajadhyaksha Consideration Rs. 86,00,000",
  "3. Document No 6732/2011 Date 23-08-2011 Nature: Mortgage by deposit of title deeds",
  "   Executant: Vihaan Rajadhyaksha Claimant: Varuna Sahakari Bank Ltd. Loan No HL-77120 Rs. 45,00,000",
  "4. Document No 9184/2023 Date 14-02-2023 Nature: Release deed",
  "   Executant: Varuna Sahakari Bank Ltd. Claimant: Vihaan Rajadhyaksha Loan No HL-77120",
  "",
  "No other transaction found for the period searched."
];
export const DEMO_ROR = [
  "PROPERTY CARD (Record of Rights)",
  "City Survey Office, Kurla",
  "C.T.S. No. 28/4, Village Chandivali, Taluka Kurla, District Mumbai Suburban",
  "Owner Name: Vihaan Rajadhyaksha",
  "Area: 92.5 sq. m",
  "Tenure: C (freehold)",
  "Other rights: Nil"
];
export const DEMO_EC_DEFECT = [
  "SEARCH REPORT / ENCUMBRANCE CERTIFICATE",
  "Office of the Sub-Registrar, Borivali, Mumbai Suburban District",
  "Property: C.T.S. No. 112/7, Village Kandivali, Taluka Borivali, District Mumbai Suburban",
  "Search period from 01-01-1995 to 15-10-2026",
  "",
  "1. Document No 4410/2004 Date 19-07-2004 Nature: Sale Deed",
  "   Executant: Ramesh Naik Claimant: Kabir Sabnis Consideration Rs. 31,00,000",
  "2. Document No 7719/2022 Date 03-03-2022 Nature: Mortgage by deposit of title deeds",
  "   Executant: Kabir Sabnis Claimant: Navdeep Home Finance Ltd. Loan No NHF-55021 Rs. 38,40,000",
  "",
  "No release or reconveyance found for the period searched."
];
export const DEMO_ROR_DEFECT = [
  "PROPERTY CARD (Record of Rights)",
  "City Survey Office, Borivali",
  "C.T.S. No. 112/7, Village Kandivali, Taluka Borivali, District Mumbai Suburban",
  "Owner Name: Kabir Sabnis",
  "Area: 74.0 sq. m",
  "Tenure: C (freehold)",
  "Other rights: Nil"
];

export async function textPdf(lines: string[], footer: string) {
  const d = await PDFDocument.create();
  const p = d.addPage([595, 842]);
  const f = await d.embedFont(StandardFonts.Helvetica), b = await d.embedFont(StandardFonts.HelveticaBold);
  lines.forEach((l, i) => p.drawText(l, { x: 48, y: 780 - i * 18, size: i === 0 ? 13 : 10, font: i === 0 ? b : f, color: rgb(0.1, 0.1, 0.1) }));
  p.drawText(footer, { x: 48, y: 40, size: 7, font: f, color: rgb(0.5, 0.5, 0.5) });
  return Buffer.from(await d.save());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = path.join(REPO_ROOT, "demo");
  fs.mkdirSync(dir, { recursive: true });
  const a = "Specimen record for the TitleShield walkthrough (fictional). Scenario A: CTS 28/4, Chandivali.";
  const b = "Specimen record for the TitleShield walkthrough (fictional). Scenario B: CTS 112/7, Kandivali.";
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".pdf"))) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, "A_EC_Chandivali_CTS-28-4.pdf"), await textPdf(DEMO_EC, a));
  fs.writeFileSync(path.join(dir, "A_PropertyCard_Chandivali_CTS-28-4.pdf"), await textPdf(DEMO_ROR, a));
  fs.writeFileSync(path.join(dir, "B_EC_Kandivali_CTS-112-7.pdf"), await textPdf(DEMO_EC_DEFECT, b));
  fs.writeFileSync(path.join(dir, "B_PropertyCard_Kandivali_CTS-112-7.pdf"), await textPdf(DEMO_ROR_DEFECT, b));
  console.log("Wrote 4 specimen PDFs to demo/");
}
