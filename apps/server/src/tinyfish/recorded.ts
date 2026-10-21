import { config } from "../config.ts";
import type { AgentRole, PropertyQuery } from "@titleshield/core";
import type { FetchError, FetchResult, SearchResult } from "./client.ts";

/**
 * Recorded TinyFish Search + Fetch runs for the two walkthrough properties in demo/README.md,
 * so a demo gives the same result every time (and works offline). They go through exactly the
 * same agent code as live runs: queries, ranking, page reading, matching and scoring.
 * Every other address uses the live TinyFish API. Turn off with DEMO_PROPERTIES=false.
 */

type Q = PropertyQuery & { locality?: string | null };
interface Page { title: string; text: string }
interface Scenario {
  id: string;
  owner: string;
  survey: string;
  search: (role: Exclude<AgentRole, "RECORDS">, query: string, qy: Q) => SearchResult[];
  page: (url: string, qy: Q) => Page | null;
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const placeOf = (qy: Q) => (qy.village || qy.locality || "").trim() || "Mumbai";
const districtOf = (qy: Q) => (qy.district || "").trim() || "Mumbai Suburban";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const res = (position: number, url: string, title: string, snippet: string, site: string): SearchResult => ({ position, url, title, snippet, site_name: site });

// ---------- shared pages ----------
const IK_SEARCH = (n: number) => `https://indiankanoon.org/search/?formInput=title-check-${n}`;
const ikPage: Page = { title: "Search results - Indian Kanoon", text: "Indian Kanoon - Search engine for Indian Law.\n\nNo documents matched your search. Try different words, or fewer words." };
const hcPage: Page = { title: "High Court of Bombay - Case Status", text: "Case status. Search by party name, case number, CNR number or advocate name. Select the bench: Principal Seat, Nagpur, Aurangabad, Goa, Kolhapur.\n\nNo records found for the given party name." };
const ecourtsPage: Page = { title: "eCourts Services - Case Status : Search by Party Name", text: "eCourts Services. Case Status : Search by Party Name. State: Maharashtra. Establishments: City Civil Court, Small Causes Court, Metropolitan Magistrate Courts.\n\nRecord not found." };
const ibapiPage: Page = { title: "IBAPI - Indian Banks Auction Properties Information", text: "IBAPI is a portal of Indian Banks' Association listing properties for e-auction by member banks. Search by state, district, city and property type. Select a property to view the sale notice issued by the bank." };
const egazettePage: Page = { title: "e-Gazette of India - Search Gazette", text: "The Gazette of India and the State Gazettes. Search by ministry, department, subject, gazette ID or date of publication.\n\nNo gazette matched the search criteria." };
const auctionList = (qy: Q): Page => ({
  title: `Bank auction properties in ${districtOf(qy)} | eAuctionsIndia`,
  text: `Bank auction properties in ${districtOf(qy)}, Maharashtra. 3 listings.\n\n` +
    `1. Residential flat, Malad West. Flat No. 704, 7th floor, CTS No. 615/A, Village Malad. Reserve price Rs. 92,00,000. Varuna Sahakari Bank Ltd. Auction date 18.11.2026.\n` +
    `2. Shop, Goregaon East. Shop No. 12, ground floor, CTS No. 233, Village Pahadi Goregaon. Reserve price Rs. 41,50,000. Varuna Sahakari Bank Ltd. Auction date 25.11.2026.\n` +
    `3. Residential flat, Borivali West. Flat No. 1102, CTS No. 1450/3, Village Eksar. Reserve price Rs. 1,18,00,000. Navdeep Home Finance Ltd. Auction date 02.12.2026.\n\n` +
    `Each sale is under the SARFAESI Act, 2002. Read the bank's sale notice before bidding.`
});
const reraPage = (qy: Q): Page => ({
  title: "MahaRERA - Registered Projects",
  text: `Maharashtra Real Estate Regulatory Authority (MahaRERA). Registered projects search.\nDistrict: ${districtOf(qy)}. Location: ${placeOf(qy)}.\nProject details, registration number and completion date are shown for each registered project.`
});

// ---------- 1. Clean title: Chandivali, CTS 28/4, owner Rohan Mehta ----------
const clean: Scenario = {
  id: "clean-title",
  owner: "Rohan Mehta",
  survey: "28/4",
  search(role, query, qy) {
    const isOwner = /rohan mehta/i.test(query);
    if (role === "COURTS") return isOwner
      ? [res(1, IK_SEARCH(1), "Search results - Indian Kanoon", "No documents matched your search.", "Indian Kanoon"),
         res(2, "https://bombayhighcourt.nic.in/case_query.php", "High Court of Bombay - Case Status", "Search case status by party name, case number or CNR.", "Bombay High Court"),
         res(3, "https://services.ecourts.gov.in/ecourtindia_v6/?p=casestatus/index", "eCourts Services - Case Status", "Search by party name across district courts.", "eCourts")]
      : [res(1, IK_SEARCH(2), "Search results - Indian Kanoon", "No documents matched your search.", "Indian Kanoon")];
    if (role === "BANK_NOTICES") return /possession notice sarfaesi/i.test(query) && !isOwner
      ? [res(1, `https://www.eauctionsindia.com/city/${slug(districtOf(qy))}`, `Bank auction properties in ${districtOf(qy)} | eAuctionsIndia`, `Residential flats and shops in ${districtOf(qy)} listed for e-auction by banks under SARFAESI.`, "eAuctionsIndia")]
      : isOwner
        ? [res(1, "https://ibapi.in/Sale_Info_Home.aspx", "IBAPI - Indian Banks Auction Properties Information", "Properties listed for e-auction by member banks of the Indian Banks' Association.", "IBAPI")]
        : [res(1, `https://www.eauctionsindia.com/city/${slug(districtOf(qy))}`, `Bank auction properties in ${districtOf(qy)} | eAuctionsIndia`, `3 bank auction listings in ${districtOf(qy)}.`, "eAuctionsIndia"),
           res(2, "https://ibapi.in/Sale_Info_Home.aspx", "IBAPI - Indian Banks Auction Properties Information", "Search bank auction properties by state and city.", "IBAPI")];
    // GOVT_NOTICES
    if (/rera/i.test(query)) return [res(1, "https://maharera.maharashtra.gov.in/projects-search-result", "MahaRERA - Registered Projects", `Registered real estate projects in ${districtOf(qy)}.`, "MahaRERA")];
    if (/acquisition/i.test(query)) return [res(1, "https://egazette.gov.in/(S(search))/default.aspx", "e-Gazette of India - Search Gazette", "Search the Gazette of India and State Gazettes.", "eGazette")];
    return [];
  },
  page(url, qy) {
    if (url.startsWith("https://indiankanoon.org/")) return ikPage;
    if (url.startsWith("https://bombayhighcourt.nic.in/")) return hcPage;
    if (url.startsWith("https://services.ecourts.gov.in/")) return ecourtsPage;
    if (url.startsWith("https://ibapi.in/")) return ibapiPage;
    if (url.startsWith("https://www.eauctionsindia.com/city/")) return auctionList(qy);
    if (url.startsWith("https://maharera.maharashtra.gov.in/")) return reraPage(qy);
    if (url.startsWith("https://egazette.gov.in/")) return egazettePage;
    return null;
  }
};

// ---------- 2. Undisclosed bank lien: Kandivali, CTS 112/7, owner Suresh Patil ----------
const NOTICE_URL = (qy: Q) => `https://www.navdeephomefinance.in/public-notices/possession-notice-${slug(placeOf(qy))}-cts-112-7`;
const AUCTION_URL = (qy: Q) => `https://www.eauctionsindia.com/properties/residential-flat-${slug(placeOf(qy))}-cts-112-7`;
const possessionNotice = (qy: Q): Page => ({
  title: "Possession Notice - Navdeep Home Finance Ltd.",
  text: `NAVDEEP HOME FINANCE LTD.\nRegistered Office: Nariman Point, Mumbai 400021\n\nPOSSESSION NOTICE\n[Rule 8(1) of the Security Interest (Enforcement) Rules, 2002] (for immovable property)\n\n` +
    `Whereas the undersigned, being the Authorised Officer of Navdeep Home Finance Ltd. under the Securitisation and Reconstruction of Financial Assets and Enforcement of Security Interest Act, 2002 (SARFAESI Act), ` +
    `and in exercise of powers conferred under Section 13(12) read with Rule 3, issued a Demand Notice under Section 13(2) of the Act calling upon the borrower Suresh Patil to repay the amount mentioned in the notice being Rs. 38,40,000/- (Rupees Thirty Eight Lakh Forty Thousand only) within 60 days from the date of receipt of the said notice.\n\n` +
    `The borrower having failed to repay the amount, notice is hereby given to the borrower and the public in general that the undersigned has taken symbolic possession of the property described herein below in exercise of powers conferred on him under Section 13(4) of the said Act read with Rule 8 of the said Rules on 12.08.2026.\n\n` +
    `The borrower in particular and the public in general are hereby cautioned not to deal with the property and any dealings with the property will be subject to the charge of Navdeep Home Finance Ltd. for an amount of Rs. 38,40,000/- and interest thereon.\n\n` +
    `DESCRIPTION OF THE IMMOVABLE PROPERTY\nAll that piece and parcel of residential Flat No. 502, 5th floor, bearing C.T.S. No. 112/7, Village ${placeOf(qy)}, Taluka Borivali, District ${districtOf(qy)}, Maharashtra.\n\n` +
    `Date: 12.08.2026\nPlace: Mumbai\nAuthorised Officer, Navdeep Home Finance Ltd.`
});
const auctionNotice = (qy: Q): Page => ({
  title: `Residential flat, ${placeOf(qy)}, ${districtOf(qy)} - e-auction | eAuctionsIndia`,
  text: `E-AUCTION SALE NOTICE under the SARFAESI Act, 2002 read with Rule 8(6) of the Security Interest (Enforcement) Rules, 2002.\n` +
    `Secured creditor: Navdeep Home Finance Ltd. Borrower: Suresh Patil.\n` +
    `Property: Flat No. 502, 5th floor, C.T.S. No. 112/7, Village ${placeOf(qy)}, Taluka Borivali, District ${districtOf(qy)}.\n` +
    `Outstanding: Rs. 38,40,000 plus interest. Possession taken on 12.08.2026. Reserve price and auction date to be notified.`
});

const lien: Scenario = {
  id: "bank-lien",
  owner: "Suresh Patil",
  survey: "112/7",
  search(role, query, qy) {
    const notice = res(1, NOTICE_URL(qy), "Possession Notice - Navdeep Home Finance Ltd.", `...symbolic possession of residential Flat No. 502 bearing C.T.S. No. 112/7, Village ${placeOf(qy)}, Taluka Borivali...`, "Navdeep Home Finance");
    const auction = res(2, AUCTION_URL(qy), `Residential flat, ${placeOf(qy)} - e-auction | eAuctionsIndia`, `Secured creditor: Navdeep Home Finance Ltd. C.T.S. No. 112/7, Village ${placeOf(qy)}. Possession taken on 12.08.2026.`, "eAuctionsIndia");
    if (role === "BANK_NOTICES") {
      if (/possession notice sarfaesi/i.test(query)) return [notice, auction, res(3, "https://ibapi.in/Sale_Info_Home.aspx", "IBAPI - Indian Banks Auction Properties Information", "Search bank auction properties by state and city.", "IBAPI")];
      return [{ ...auction, position: 1 }, res(2, `https://www.eauctionsindia.com/city/${slug(districtOf(qy))}`, `Bank auction properties in ${districtOf(qy)} | eAuctionsIndia`, `3 bank auction listings in ${districtOf(qy)}.`, "eAuctionsIndia")];
    }
    return clean.search(role, query.replace(/suresh patil/i, "x"), qy);
  },
  page(url, qy) {
    if (url === NOTICE_URL(qy)) return possessionNotice(qy);
    if (url === AUCTION_URL(qy)) return auctionNotice(qy);
    return clean.page(url, qy);
  }
};

const SCENARIOS = [clean, lien];

export function recordedScenario(qy: Q): Scenario | null {
  if (!config.DEMO_PROPERTIES) return null;
  return SCENARIOS.find((s) => norm(s.survey) === norm(qy.surveyNumber) && norm(s.owner) === norm(qy.claimedOwnerName)) ?? null;
}

const pause = (min: number, max: number) => new Promise((r) => setTimeout(r, config.NODE_ENV === "test" ? 5 : min + Math.random() * (max - min)));

export async function recordedSearch(sc: Scenario, role: Exclude<AgentRole, "RECORDS">, query: string, qy: Q, domains?: string[]) {
  await pause(700, 1500);
  const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const results = sc.search(role, query, qy).filter((r) => !domains?.length || domains.some((d) => host(r.url) === d || host(r.url).endsWith(`.${d}`)));
  return { results, cached: false };
}

export async function recordedFetch(sc: Scenario, urls: string[], qy: Q): Promise<{ results: FetchResult[]; errors: FetchError[] }> {
  await pause(1500, 2800);
  const results: FetchResult[] = [], errors: FetchError[] = [];
  for (const url of urls) {
    const p = sc.page(url, qy);
    if (p) results.push({ url, final_url: url, title: p.title, text: p.text });
    else errors.push({ url, error: "timeout" });
  }
  return { results, errors };
}
