/**
 * State registry: the official portals where an owner gets the Record of Rights
 * (land revenue) and the Encumbrance Certificate (registration), the High Court
 * whose orders are searched, and the state RERA. Used for the agents' searches,
 * for portal reachability checks, and to tell users where to download records.
 *
 * A null portal means no single statewide online service is known; the
 * location agent then looks one up with TinyFish Search on gov.in / nic.in.
 */

export type AgentRole = "RECORDS" | "COURTS" | "BANK_NOTICES" | "GOVT_NOTICES";
export const AGENT_ROLES: AgentRole[] = ["RECORDS", "COURTS", "BANK_NOTICES", "GOVT_NOTICES"];

export interface Portal { name: string; url: string }

export interface StateDef {
  code: string;
  name: string;
  aliases: string[];
  language: string;
  langCode: string;
  /** Labels for district → sub-district → village → parcel, as used locally. */
  hierarchy: [string, string, string, string];
  revenue: Portal | null;
  encumbrance: Portal | null;
  highCourt: { name: string; domain: string };
  rera: Portal | null;
}

const S = (
  code: string, name: string, aliases: string[], language: string, langCode: string,
  hierarchy: [string, string, string, string],
  revenue: Portal | null, encumbrance: Portal | null,
  highCourt: { name: string; domain: string }, rera: Portal | null
): StateDef => ({ code, name, aliases, language, langCode, hierarchy, revenue, encumbrance, highCourt, rera });

const HC = {
  gauhati: { name: "Gauhati High Court", domain: "ghconline.gov.in" },
  bombay: { name: "Bombay High Court", domain: "bombayhighcourt.nic.in" },
  madras: { name: "Madras High Court", domain: "mhc.tn.gov.in" },
  calcutta: { name: "Calcutta High Court", domain: "calcuttahighcourt.gov.in" },
  ph: { name: "Punjab and Haryana High Court", domain: "phhc.gov.in" },
  kerala: { name: "High Court of Kerala", domain: "hckerala.gov.in" }
};

const LIST: StateDef[] = [
  S("AP", "Andhra Pradesh", ["andhra"], "Telugu", "te-IN", ["District", "Mandal", "Village", "Survey no."],
    { name: "MeeBhoomi (Adangal / 1-B)", url: "https://meebhoomi.ap.gov.in/" }, { name: "IGRS Andhra Pradesh (EC)", url: "https://registration.ap.gov.in/" },
    { name: "High Court of Andhra Pradesh", domain: "aphc.gov.in" }, { name: "AP RERA", url: "https://rera.ap.gov.in/" }),
  S("AR", "Arunachal Pradesh", [], "English", "en-IN", ["District", "Circle", "Village", "Plot no."], null, null, HC.gauhati, null),
  S("AS", "Assam", [], "Assamese", "as-IN", ["District", "Circle", "Village", "Dag no."],
    { name: "Dharitree (Jamabandi)", url: "https://dharitree.assam.gov.in/" }, null, HC.gauhati, null),
  S("BR", "Bihar", [], "Hindi", "hi-IN", ["District", "Circle / Anchal", "Mauza", "Khesra no."],
    { name: "Bihar Bhumi (Jamabandi)", url: "https://biharbhumi.bihar.gov.in/" }, { name: "Bhumi Jankari (registration)", url: "https://bhumijankari.bihar.gov.in/" },
    { name: "Patna High Court", domain: "patnahighcourt.gov.in" }, { name: "RERA Bihar", url: "https://rera.bihar.gov.in/" }),
  S("CG", "Chhattisgarh", [], "Hindi", "hi-IN", ["District", "Tehsil", "Village", "Khasra no."],
    { name: "Bhuiyan", url: "https://bhuiyan.cg.nic.in/" }, null, { name: "High Court of Chhattisgarh", domain: "highcourt.cg.gov.in" }, null),
  S("GA", "Goa", [], "Konkani", "en-IN", ["District", "Taluka", "Village", "Survey no."], null, null, HC.bombay, null),
  S("GJ", "Gujarat", [], "Gujarati", "gu-IN", ["District", "Taluka", "Village", "Survey / Block no."],
    { name: "AnyROR (7/12, 8A)", url: "https://anyror.gujarat.gov.in/" }, { name: "GARVI (registration)", url: "https://garvi.gujarat.gov.in/" },
    { name: "Gujarat High Court", domain: "gujarathighcourt.nic.in" }, { name: "GujRERA", url: "https://gujrera.gujarat.gov.in/" }),
  S("HR", "Haryana", [], "Hindi", "hi-IN", ["District", "Tehsil", "Village", "Khasra / Killa no."],
    { name: "Jamabandi Haryana", url: "https://jamabandi.nic.in/" }, { name: "Jamabandi Haryana (deed search)", url: "https://jamabandi.nic.in/" },
    HC.ph, { name: "HRERA", url: "https://haryanarera.gov.in/" }),
  S("HP", "Himachal Pradesh", [], "Hindi", "hi-IN", ["District", "Tehsil", "Mauza", "Khasra no."], null, null,
    { name: "High Court of Himachal Pradesh", domain: "hphighcourt.nic.in" }, null),
  S("JH", "Jharkhand", [], "Hindi", "hi-IN", ["District", "Circle / Anchal", "Mauza", "Plot / Khata no."],
    { name: "Jharbhoomi", url: "https://jharbhoomi.jharkhand.gov.in/" }, null, { name: "Jharkhand High Court", domain: "jharkhandhighcourt.nic.in" }, null),
  S("KA", "Karnataka", [], "Kannada", "kn-IN", ["District", "Taluk", "Village", "Survey / Surnoc / Hissa"],
    { name: "Bhoomi (RTC / Pahani)", url: "https://landrecords.karnataka.gov.in/" }, { name: "Kaveri Online Services (EC)", url: "https://kaveri.karnataka.gov.in/" },
    { name: "High Court of Karnataka", domain: "karnatakajudiciary.kar.nic.in" }, { name: "RERA Karnataka", url: "https://rera.karnataka.gov.in/" }),
  S("KL", "Kerala", [], "Malayalam", "ml-IN", ["District", "Taluk", "Village", "Re-survey / Survey no."],
    { name: "e-Rekha / ReLIS (revenue)", url: "https://erekha.kerala.gov.in/" }, { name: "Kerala Registration (PEARL)", url: "https://pearl.registration.kerala.gov.in/" },
    HC.kerala, { name: "K-RERA", url: "https://rera.kerala.gov.in/" }),
  S("MP", "Madhya Pradesh", [], "Hindi", "hi-IN", ["District", "Tehsil", "Village", "Khasra no."],
    { name: "MP Bhulekh", url: "https://mpbhulekh.gov.in/" }, { name: "Sampada (registration)", url: "https://sampada.mpigr.gov.in/" },
    { name: "High Court of Madhya Pradesh", domain: "mphc.gov.in" }, { name: "MP RERA", url: "https://rera.mp.gov.in/" }),
  S("MH", "Maharashtra", [], "Marathi", "mr-IN", ["District", "Taluka", "Village", "Survey / Gat no."],
    { name: "MahaBhulekh (7/12)", url: "https://bhulekh.mahabhumi.gov.in/" }, { name: "IGR Maharashtra (Index-II e-search)", url: "https://igrmaharashtra.gov.in/" },
    HC.bombay, { name: "MahaRERA", url: "https://maharera.maharashtra.gov.in/" }),
  S("MN", "Manipur", [], "Meitei", "en-IN", ["District", "Sub-division", "Village", "Dag no."], null, null, { name: "High Court of Manipur", domain: "manipurhighcourt.nic.in" }, null),
  S("ML", "Meghalaya", [], "English", "en-IN", ["District", "Block", "Village", "Plot no."], null, null, { name: "High Court of Meghalaya", domain: "meghalayahighcourt.nic.in" }, null),
  S("MZ", "Mizoram", [], "Mizo", "en-IN", ["District", "Sub-division", "Village", "LSC / Pass no."], null, null, HC.gauhati, null),
  S("NL", "Nagaland", [], "English", "en-IN", ["District", "Circle", "Village", "Plot no."], null, null, HC.gauhati, null),
  S("OD", "Odisha", ["orissa"], "Odia", "or-IN", ["District", "Tahasil", "Village / Mouza", "Khata / Plot no."],
    { name: "Bhulekh Odisha", url: "https://bhulekh.ori.nic.in/" }, { name: "IGR Odisha", url: "https://igrodisha.gov.in/" },
    { name: "Orissa High Court", domain: "orissahighcourt.nic.in" }, { name: "ORERA", url: "https://rera.odisha.gov.in/" }),
  S("PB", "Punjab", [], "Punjabi", "pa-IN", ["District", "Tehsil", "Village", "Khasra no."],
    { name: "Jamabandi Punjab", url: "https://jamabandi.punjab.gov.in/" }, { name: "IGR Punjab", url: "https://igrpunjab.gov.in/" },
    HC.ph, { name: "Punjab RERA", url: "https://rera.punjab.gov.in/" }),
  S("RJ", "Rajasthan", [], "Hindi", "hi-IN", ["District", "Tehsil", "Village", "Khasra no."],
    { name: "Apna Khata (Jamabandi)", url: "https://apnakhata.rajasthan.gov.in/" }, { name: "e-Panjiyan (registration)", url: "https://epanjiyan.rajasthan.gov.in/" },
    { name: "Rajasthan High Court", domain: "hcraj.nic.in" }, { name: "RERA Rajasthan", url: "https://rera.rajasthan.gov.in/" }),
  S("SK", "Sikkim", [], "Nepali", "en-IN", ["District", "Sub-division", "Block", "Plot no."], null, null, { name: "High Court of Sikkim", domain: "hcs.gov.in" }, null),
  S("TN", "Tamil Nadu", ["tamilnadu"], "Tamil", "ta-IN", ["District", "Taluk", "Village", "Survey / Sub-division"],
    { name: "TN eServices (Patta / Chitta)", url: "https://eservices.tn.gov.in/" }, { name: "TNREGINET (EC)", url: "https://tnreginet.gov.in/" },
    HC.madras, { name: "TNRERA", url: "https://rera.tn.gov.in/" }),
  S("TS", "Telangana", [], "Telugu", "te-IN", ["District", "Mandal", "Village", "Survey no."],
    { name: "Bhu Bharati (formerly Dharani)", url: "https://bhubharati.telangana.gov.in/" }, { name: "IGRS Telangana (EC)", url: "https://registration.telangana.gov.in/" },
    { name: "High Court for the State of Telangana", domain: "tshc.gov.in" }, { name: "TS RERA", url: "https://rera.telangana.gov.in/" }),
  S("TR", "Tripura", [], "Bengali", "bn-IN", ["District", "Sub-division", "Mouja", "Plot / Khatian no."], null, null, { name: "High Court of Tripura", domain: "thc.nic.in" }, null),
  S("UP", "Uttar Pradesh", [], "Hindi", "hi-IN", ["District", "Tehsil", "Village", "Khasra / Gata no."],
    { name: "UP Bhulekh (Khatauni)", url: "https://upbhulekh.gov.in/" }, { name: "IGRS Uttar Pradesh", url: "https://igrsup.gov.in/" },
    { name: "Allahabad High Court", domain: "allahabadhighcourt.in" }, { name: "UP RERA", url: "https://up-rera.in/" }),
  S("UK", "Uttarakhand", ["uttaranchal"], "Hindi", "hi-IN", ["District", "Tehsil", "Village", "Khasra no."],
    { name: "Bhulekh Uttarakhand", url: "https://bhulekh.uk.gov.in/" }, null, { name: "High Court of Uttarakhand", domain: "highcourtofuttarakhand.gov.in" }, null),
  S("WB", "West Bengal", [], "Bengali", "bn-IN", ["District", "Block", "Mouza", "Plot / Khatian no."],
    { name: "Banglarbhumi", url: "https://banglarbhumi.gov.in/" }, { name: "WB Registration", url: "https://wbregistration.gov.in/" },
    HC.calcutta, null),
  // Union territories
  S("DL", "Delhi", ["national capital territory of delhi", "nct of delhi", "new delhi"], "Hindi", "hi-IN", ["District", "Sub-division / Tehsil", "Village / Colony", "Khasra / Plot no."],
    { name: "Bhulekh Delhi (DLRC)", url: "https://dlrc.delhigovt.nic.in/" }, null, { name: "Delhi High Court", domain: "delhihighcourt.nic.in" }, null),
  S("CH", "Chandigarh", [], "Hindi", "hi-IN", ["District", "Tehsil", "Village / Sector", "Khasra / Plot no."], null, null, HC.ph, null),
  S("JK", "Jammu and Kashmir", ["jammu & kashmir"], "Urdu", "ur-IN", ["District", "Tehsil", "Village", "Khasra no."], null, null,
    { name: "High Court of Jammu & Kashmir and Ladakh", domain: "jkhighcourt.nic.in" }, null),
  S("LA", "Ladakh", [], "Ladakhi", "en-IN", ["District", "Tehsil", "Village", "Khasra no."], null, null,
    { name: "High Court of Jammu & Kashmir and Ladakh", domain: "jkhighcourt.nic.in" }, null),
  S("PY", "Puducherry", ["pondicherry"], "Tamil", "ta-IN", ["District", "Taluk", "Village / Revenue village", "Re-survey no."], null, null, HC.madras, null),
  S("AN", "Andaman and Nicobar Islands", ["andaman & nicobar islands"], "Hindi", "hi-IN", ["District", "Tehsil", "Village", "Plot no."], null, null, HC.calcutta, null),
  S("DN", "Dadra and Nagar Haveli and Daman and Diu", ["dadra and nagar haveli", "daman and diu"], "Gujarati", "gu-IN", ["District", "Tehsil", "Village", "Survey no."], null, null, HC.bombay, null),
  S("LD", "Lakshadweep", [], "Malayalam", "ml-IN", ["District", "Tehsil", "Island", "Survey no."], null, null, HC.kerala, null)
];

export const STATES: Record<string, StateDef> = Object.fromEntries(LIST.map((s) => [s.code, s]));

const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/** Map a state name from a geocoder / India Post ("Orissa", "NCT of Delhi") to its code. */
export function stateCodeFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = norm(name);
  if (STATES[name.toUpperCase()]) return name.toUpperCase();
  for (const s of LIST) {
    if (norm(s.name) === n || s.aliases.some((a) => norm(a) === n)) return s.code;
  }
  for (const s of LIST) if (n.includes(norm(s.name))) return s.code;
  return null;
}

export interface PropertyQuery {
  stateCode: string;
  district: string;
  taluk: string;
  village: string;
  surveyNumber: string;
  hobli?: string | null;
  subDivisionHissa?: string | null;
  claimedOwnerName?: string | null;
  pastOwnerNames?: string[];
  addressText?: string | null;
  pincode?: string | null;
}

/** Court and judgment databases searched by the litigation agent. */
export const COURT_DOMAINS = ["indiankanoon.org", "ecourts.gov.in", "judgments.ecourts.gov.in", "casemine.com", "sci.gov.in"];
/** Where banks publish SARFAESI possession / auction notices. */
export const BANK_NOTICE_DOMAINS = ["ibapi.in", "baanknet.com", "eauctionsindia.com", "bankeauctions.com", "mstcecommerce.com", "auctiontiger.net", "bankauctions.in", "foreclosureindia.com"];
/** Government notification sources. */
export const GOVT_DOMAINS = ["egazette.gov.in", "gov.in", "nic.in"];
