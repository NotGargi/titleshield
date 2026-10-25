/**
 * Stand-in for the external free services, speaking their published wire formats:
 *   TinyFish Search  GET  /search/?query=…  → { query, results:[{position,site_name,snippet,title,url}], total_results, page }
 *   TinyFish Fetch   POST /fetch/ {urls}    → { results:[{url,final_url,title,text,…}], errors:[{url,error,status}] }
 *   Nominatim        GET  /nominatim/search, /nominatim/reverse (jsonv2 + addressdetails)
 *   Photon           GET  /photon/api/?q=   (GeoJSON features)
 *   India Post       GET  /pincode/pincode/:pin
 *   Gemini           POST /gemini/…:generateContent
 * Lets the end-to-end suite run the real code paths without internet access.
 */
import http from "node:http";

export const TF_KEY = "tf_test_free_key_123";
export const GEMINI_KEY = "gm_test_key_456";

export const state = { hebbalNewLoan: false, calls: { search: 0, fetch: 0, nominatim: 0, gemini: 0 }, log: [] as string[] };

const PAGES: Record<string, { title: string; text: string }> = {
  "https://en.wikipedia.org/wiki/Hebbal": { title: "Hebbal - Wikipedia", text: "Hebbal is a neighbourhood in north Bengaluru known for its lake and flyover." },
  "https://www.hdfcbank.example/notices/kondli-312": { title: "Possession Notice - HDFC Bank Ltd", text: "HDFC Bank Ltd. POSSESSION NOTICE (Under Rule 8(1) of the Security Interest (Enforcement) Rules, 2002). Whereas the Authorised Officer of HDFC Bank Ltd issued a demand notice under section 13(2) of the SARFAESI Act calling upon the borrower: Ramesh Kumar Sharma to repay the outstanding amount of Rs. 48,00,000. Description of the property: all that part and parcel of land bearing Khasra No. 312, Village Kondli Bangar, Tehsil Dadri, District Gautam Buddha Nagar. Date: 14.06.2025. Place: Noida." },
  "https://indiankanoon.org/doc/778899/": { title: "Padmavathi K vs Srinivasa Reddy on 17 February, 2025", text: "IN THE COURT OF THE PRINCIPAL SENIOR CIVIL JUDGE, GUNTUR. O.S. No. 214/2025. Suit for partition and permanent injunction in respect of land in Survey No. 78/3 of Navuluru village, Mangalagiri Mandal. Padmavathi K ... Plaintiff. Srinivasa Reddy ... Defendant. Interim injunction granted restraining the defendant from alienating the suit schedule property till the next date of hearing. List after four weeks." },
  "https://egazette.gov.in/notice/chandapura-118": { title: "Preliminary Notification - Land Acquisition, Anekal Taluk", text: "Government of Karnataka. Preliminary notification under section 11(1) of the RFCTLARR Act, 2013. The land described in the schedule is likely to be needed for a public purpose, namely the Peripheral Ring Road. Schedule: Village Chandapura, Attibele Hobli, Anekal Taluk, Survey No. 118/4, extent 2 acres 05 guntas." },
  "https://indiankanoon.org/doc/445566/": { title: "Anita Desai vs State Of Karnataka on 4 July, 2022", text: "IN THE HIGH COURT OF KARNATAKA. Writ Petition No. 12345/2021. Anita Desai, residing at Whitefield, Bengaluru ... Petitioner. The petitioner challenges the khata transfer order. The petition is pending; list after vacation." },
  "https://www.bajaj.example/hebbal-42-2b": { title: "Possession Notice - Bajaj Finance Limited", text: "Bajaj Finance Limited. POSSESSION NOTICE under SARFAESI Act. Borrower: Venkatesh Murthy. Secured asset: Sy. No. 42/2B, Hebbal village, Bengaluru North Taluk. Outstanding Rs. 25,00,000. Date: 10.10.2026." },
  "https://kaveri.karnataka.gov.in/": { title: "Kaveri Online Services", text: "Kaveri Online Services - Department of Stamps and Registration, Government of Karnataka." },
  "https://landrecords.karnataka.gov.in/": { title: "Bhoomi", text: "Bhoomi land records, Revenue Department, Government of Karnataka." },
  "https://example.com/": { title: "Example Domain", text: "This domain is for use in illustrative examples in documents." },
  "https://igrmaharashtra.gov.in/eSearch": { title: "IGR Maharashtra - eSearch", text: "Index-II eSearch. Select district, village and enter property number." }
};
/** Documented Fetch request fields (docs.tinyfish.ai/fetch-api/reference). Anything else → 400, like a strict API. */
const FETCH_FIELDS = new Set(["urls", "purpose", "format", "links", "image_links", "iframe_links", "ttl", "per_url_timeout_ms", "if_none_match", "if_modified_since", "include_etag_and_last_modified", "include_selectors", "exclude_selectors", "highlights"]);

function searchResults(qs: string, domains: string[]) {
  const q = qs.toLowerCase();
  const r = (url: string, snippet: string) => ({ url, title: PAGES[url]?.title ?? url, snippet, site_name: new URL(url).hostname });
  const out: Array<ReturnType<typeof r>> = [];
  const inD = (u: string) => !domains.length || domains.some((d) => new URL(u).hostname.endsWith(d));
  if (q.includes("encumbrance certificate online karnataka")) out.push(r("https://kaveri.karnataka.gov.in/", "Apply for Encumbrance Certificate online"));
  if (q.includes("igr maharashtra index ii")) out.push(r("https://igrmaharashtra.gov.in/eSearch", "Index-II eSearch"));
  if (q.includes("baner") && q.includes("possession notice")) {
    // URL validation fixtures: private address, local host, duplicate, and a relevant page that blocks bots.
    out.push({ url: "http://10.0.0.5/notice-55", title: "internal", snippet: "Survey No. 55 Baner", site_name: "10.0.0.5" } as any);
    out.push({ url: "http://localhost/notice", title: "local", snippet: "notice", site_name: "localhost" } as any);
    out.push(r("https://www.blockedbank.example/baner-55", "Possession notice ... Survey No. 55, Village Baner, Haveli Taluka"));
    out.push(r("https://www.blockedbank.example/baner-55#top", "duplicate of the same notice"));
  }
  if (q.includes("kondli") && q.includes("possession notice")) out.push(r("https://www.hdfcbank.example/notices/kondli-312", "Possession notice Khasra No. 312 Kondli Bangar"));
  if (q.includes("navuluru") || (q.includes("srinivasa reddy") && q.includes("suit"))) out.push(r("https://indiankanoon.org/doc/778899/", "Suit for partition ... Survey No. 78/3 of Navuluru"));
  if (q.includes("chandapura") && q.includes("acquisition")) out.push(r("https://egazette.gov.in/notice/chandapura-118", "Preliminary notification ... Chandapura"));
  if (q.includes("anita desai")) out.push(r("https://indiankanoon.org/doc/445566/", "Anita Desai, residing at Whitefield"));
  if (q.includes("hebbal")) {
    out.push(r("https://en.wikipedia.org/wiki/Hebbal", "Hebbal is a neighbourhood in north Bengaluru"));
    if (state.hebbalNewLoan && q.includes("possession notice")) out.push(r("https://www.bajaj.example/hebbal-42-2b", "Possession notice Sy. No. 42/2B Hebbal"));
  }
  return out.filter((x) => inD(x.url)).map((x, i) => ({ position: i + 1, ...x }));
}

const NOMINATIM: Array<{ match: RegExp; hit: any }> = [
  { match: /whitefield|560048/i, hit: { lat: "12.9698", lon: "77.7500", display_name: "Prestige Shantiniketan, Whitefield, Bengaluru, Karnataka, 560048, India", address: { suburb: "Whitefield", city: "Bengaluru", county: "Bangalore East", state_district: "Bengaluru Urban", state: "Karnataka", "ISO3166-2-lvl4": "IN-KA", postcode: "560048", country_code: "in" } } },
  { match: /hebbal/i, hit: { lat: "13.0358", lon: "77.5970", display_name: "Hebbal, Bengaluru, Karnataka, 560024, India", address: { suburb: "Hebbal", city: "Bengaluru", county: "Bengaluru North", state_district: "Bengaluru Urban", state: "Karnataka", postcode: "560024", country_code: "in" } } },
  { match: /kondli/i, hit: { lat: "28.4744", lon: "77.5040", display_name: "Kondli Bangar, Dadri, Gautam Buddha Nagar, Uttar Pradesh, India", address: { village: "Kondli Bangar", county: "Dadri", state_district: "Gautam Buddha Nagar", state: "Uttar Pradesh", postcode: "201310", country_code: "in" } } },
  { match: /navuluru/i, hit: { lat: "16.4720", lon: "80.5410", display_name: "Navuluru, Mangalagiri, Guntur, Andhra Pradesh, India", address: { village: "Navuluru", county: "Mangalagiri", state_district: "Guntur", state: "Andhra Pradesh", postcode: "522503", country_code: "in" } } },
  { match: /chandivali|400072/i, hit: { lat: "19.1103", lon: "72.8997", display_name: "Chandivali, Kurla, Mumbai Suburban, Maharashtra, 400072, India", address: { suburb: "Chandivali", city: "Mumbai", county: "Kurla", state_district: "Mumbai Suburban", state: "Maharashtra", "ISO3166-2-lvl4": "IN-MH", postcode: "400072", country_code: "in" } } },
  { match: /kandivali|400067/i, hit: { lat: "19.2047", lon: "72.8406", display_name: "Kandivali West, Borivali, Mumbai Suburban, Maharashtra, 400067, India", address: { suburb: "Kandivali West", city: "Mumbai", county: "Borivali", state_district: "Mumbai Suburban", state: "Maharashtra", "ISO3166-2-lvl4": "IN-MH", postcode: "400067", country_code: "in" } } },
  { match: /baner/i, hit: { lat: "18.5590", lon: "73.7868", display_name: "Baner, Haveli, Pune, Maharashtra, 411045, India", address: { suburb: "Baner", city: "Pune", county: "Haveli", state_district: "Pune", state: "Maharashtra", "ISO3166-2-lvl4": "IN-MH", postcode: "411045", country_code: "in" } } },
  { match: /chandapura/i, hit: { lat: "12.8000", lon: "77.7000", display_name: "Chandapura, Anekal, Bengaluru Urban, Karnataka, India", address: { village: "Chandapura", county: "Anekal", state_district: "Bengaluru Urban", state: "Karnataka", postcode: "562106", country_code: "in" } } }
];

const PINCODES: Record<string, any> = {
  "560048": [{ Message: "Number of pincode(s) found:2", Status: "Success", PostOffice: [{ Name: "Whitefield", BranchType: "Sub Post Office", District: "Bangalore", Block: "Bangalore East", State: "Karnataka", Country: "India", Pincode: "560048" }, { Name: "Hoodi", District: "Bangalore", Block: "Bangalore East", State: "Karnataka", Pincode: "560048" }] }],
  "560024": [{ Status: "Success", PostOffice: [{ Name: "Hebbal Kempapura", District: "Bangalore", Block: "Bangalore North", State: "Karnataka", Pincode: "560024" }] }]
};

const GEMINI_DOCS: Record<string, any> = {
  "EC|42/2B": { portalStatus: "OK", surveyNumberMatched: "42/2B", ecCoverageFromYear: 1990, currentOwnerNames: [], mutationHistory: [], litigationCases: [], rawArtifactUrls: [],
    encumbrances: [
      { documentNumber: "1874/2002-03", registrationDate: "2003-03-14", transactionNature: "Sale deed", executant: "Hanumanthappa", claimant: "Lakshmamma R", lenderOrClaimantName: null, isActiveLien: false, loanAmountINR: 900000 },
      { documentNumber: "3356/2019-20", registrationDate: "2019-09-05", transactionNature: "Sale deed", executant: "ಲಕ್ಷ್ಮಮ್ಮ ಆರ್", claimant: "Venkatesh Murthy S/O Narayana Murthy", lenderOrClaimantName: null, isActiveLien: false, loanAmountINR: 9200000 }
    ] },
  "ROR|42/2B": { portalStatus: "OK", surveyNumberMatched: "42/2B", currentOwnerNames: ["ವೆಂಕಟೇಶ ಮೂರ್ತಿ"], landExtent: "1 acre 12 guntas", encumbrances: [], litigationCases: [], rawArtifactUrls: [],
    mutationHistory: [{ mutationNumber: "MR 31/2019-20", mutationDate: "2019-12-03", transferType: "SALE", transferor: "ಲಕ್ಷ್ಮಮ್ಮ ಆರ್", transferee: "ವೆಂಕಟೇಶ ಮೂರ್ತಿ", isVerified: true }] }
};

export function startMocks(port: number): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    let body = "";
    for await (const c of req) body += c;
    const send = (code: number, obj: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

    if (url.pathname.startsWith("/search")) {
      if (req.headers["x-api-key"] !== TF_KEY) return send(401, { error: { code: "INVALID_API_KEY", message: "Invalid API key" } });
      state.calls.search++; state.log.push(`search ${url.searchParams.get("query")} | ${url.searchParams.get("include_domains") ?? ""}`);
      const domains = (url.searchParams.get("include_domains") ?? "").split(",").filter(Boolean);
      const results = searchResults(url.searchParams.get("query") ?? "", domains);
      return send(200, { query: url.searchParams.get("query"), results, total_results: results.length, page: 0 });
    }
    if (url.pathname.startsWith("/fetch")) {
      if (req.headers["x-api-key"] !== TF_KEY) return send(401, { error: { code: "INVALID_API_KEY", message: "Invalid API key" } });
      const parsed = JSON.parse(body || "{}");
      const unknown = Object.keys(parsed).filter((k) => !FETCH_FIELDS.has(k));
      if (unknown.length) return send(400, { error: { code: "INVALID_REQUEST", message: `Unknown field(s): ${unknown.join(", ")}` } });
      const { urls } = parsed;
      state.calls.fetch += urls.length;
      const results = urls.filter((u: string) => PAGES[u]).map((u: string) => ({ url: u, final_url: u, title: PAGES[u].title, description: "", language: "en", format: "markdown", text: PAGES[u].text, latency_ms: 120 }));
      const errors = urls.filter((u: string) => !PAGES[u]).map((u: string) => (u.includes("blockedbank") ? { url: u, error: "bot_blocked", status: 403 } : { url: u, error: "page_not_found", status: 404 }));
      return send(200, { results, errors });
    }
    if (url.pathname.startsWith("/nominatim/search")) {
      state.calls.nominatim++;
      const qtext = url.searchParams.get("q") ?? "";
      const hit = NOMINATIM.find((n) => n.match.test(qtext));
      return send(200, hit ? [{ place_id: 1, category: "place", type: "suburb", ...hit.hit }] : []);
    }
    if (url.pathname.startsWith("/nominatim/reverse")) {
      state.calls.nominatim++;
      return send(200, { place_id: 2, ...NOMINATIM[0].hit });
    }
    if (url.pathname.startsWith("/photon/api")) {
      const qtext = url.searchParams.get("q") ?? "";
      const hits = NOMINATIM.filter((n) => n.match.test(qtext)).map((n) => ({ type: "Feature", geometry: { type: "Point", coordinates: [Number(n.hit.lon), Number(n.hit.lat)] },
        properties: { name: n.hit.address.suburb ?? n.hit.address.village, county: n.hit.address.state_district, state: n.hit.address.state, countrycode: "IN", postcode: n.hit.address.postcode, district: n.hit.address.suburb } }));
      return send(200, { type: "FeatureCollection", features: hits });
    }
    if (url.pathname.startsWith("/pincode/pincode/")) {
      const pin = url.pathname.split("/").pop()!;
      return send(200, PINCODES[pin] ?? [{ Message: "No records found", Status: "Error", PostOffice: null }]);
    }
    if (url.pathname.includes(":generateContent")) {
      if (url.searchParams.get("key") !== GEMINI_KEY && req.headers["x-goog-api-key"] !== GEMINI_KEY) return send(400, { error: { code: 400, message: "API key not valid", status: "INVALID_ARGUMENT" } });
      state.calls.gemini++;
      const j = JSON.parse(body || "{}");
      const prompt: string = (j.contents?.[0]?.parts ?? []).map((p: any) => p.text ?? "").join(" ") || (typeof j.contents === "string" ? j.contents : JSON.stringify(j.contents));
      const kind = /Encumbrance Certificate/.test(prompt) ? "EC" : /Record of Rights/.test(prompt) ? "ROR" : "OTHER";
      const survey = (prompt.match(/survey number being verified is ([^;]+);/) ?? [])[1]?.trim() ?? "";
      const out = kind === "OTHER" ? "OK" : JSON.stringify(GEMINI_DOCS[`${kind}|${survey}`] ?? { portalStatus: "OK", surveyNumberMatched: survey, currentOwnerNames: [], mutationHistory: [], encumbrances: [], litigationCases: [] });
      return send(200, { candidates: [{ content: { role: "model", parts: [{ text: out }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } });
    }
    send(404, { error: "not found" });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
