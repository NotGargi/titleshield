import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { REPO_ROOT } from "../src/config.ts";

/** Builds the specimen EC and Property Card used in the walkthrough (digital PDFs with a text layer). */
export const DEMO_EC = [
  "SEARCH REPORT / ENCUMBRANCE CERTIFICATE",
  "Office of the Sub-Registrar, Kurla, Mumbai Suburban District",
  "Property: C.T.S. No. 28/4, Village Chandivali, Taluka Kurla, District Mumbai Suburban",
  "Search period from 01-01-1995 to 15-10-2026",
  "",
  "1. Document No 2214/1998 Date 11-05-1998 Nature: Sale Deed",
  "   Executant: Dinesh Kulkarni Claimant: Meera Joshi Consideration Rs. 14,50,000",
  "2. Document No 6731/2011 Date 23-08-2011 Nature: Sale Deed",
  "   Executant: Meera Joshi Claimant: Rohan Mehta Consideration Rs. 86,00,000",
  "3. Document No 6732/2011 Date 23-08-2011 Nature: Mortgage by deposit of title deeds",
  "   Executant: Rohan Mehta Claimant: Varuna Sahakari Bank Ltd. Loan No HL-77120 Rs. 45,00,000",
  "4. Document No 9184/2023 Date 14-02-2023 Nature: Release deed",
  "   Executant: Varuna Sahakari Bank Ltd. Claimant: Rohan Mehta Loan No HL-77120",
  "",
  "No other transaction found for the period searched."
];
export const DEMO_ROR = [
  "PROPERTY CARD (Record of Rights)",
  "City Survey Office, Kurla",
  "C.T.S. No. 28/4, Village Chandivali, Taluka Kurla, District Mumbai Suburban",
  "Owner Name: Rohan Mehta",
  "Area: 92.5 sq. m",
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
  const footer = "Specimen record for the TitleShield walkthrough (CTS 28/4, Chandivali).";
  fs.writeFileSync(path.join(dir, "EC_Chandivali_CTS-28-4.pdf"), await textPdf(DEMO_EC, footer));
  fs.writeFileSync(path.join(dir, "PropertyCard_Chandivali_CTS-28-4.pdf"), await textPdf(DEMO_ROR, footer));
  console.log("Wrote demo/EC_Chandivali_CTS-28-4.pdf and demo/PropertyCard_Chandivali_CTS-28-4.pdf");
}
