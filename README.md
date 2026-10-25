# TitleShield (BhoomiTrust)

**Property title search, encumbrance scoring, signed Title Clearance Certificates and programmable escrow for Indian real estate.**

Type any Indian property address and the owner's name. TitleShield:

1. finds the property on the map and works out its state, district, taluk, village and PIN (OpenStreetMap + India Post);
2. sends four agents out at the same time:
   - **Records:** reads the Encumbrance Certificate (EC) and Record of Rights (RoR) you upload, with links to the right state portals;
   - **Courts:** searches court records for cases about the property or owner;
   - **Bank notices:** searches for SARFAESI possession, auction and demand notices;
   - **Govt notices:** searches for land acquisition notifications and other restrictions;
3. reads records in Kannada, Telugu, Hindi, Marathi and other languages, including legacy Kruti Dev text;
4. rebuilds the chain of ownership and scores the title from 0 to 100 with fixed rules;
5. issues a digitally signed certificate recorded in a tamper-evident ledger.

For the escrow, the buyer deposits **test tokens** into the **TitleEscrow smart contract**. The contract releases them to the seller only on an oracle-signed *verified clean* verdict, refunds the buyer on a *qualifying defect* (for example an undisclosed mortgage), and keeps them locked when the evidence is *inconclusive*.

What changed in the latest revision, and why, is in [docs/REVISION.md](docs/REVISION.md): the change-impact table, the revised architecture, the migration plan and the test map.

The web agents use **only TinyFish's free tier: Search and Fetch.** No paid TinyFish product (Agent, Browser, Monitor) is called anywhere in the code.

This repository implements the architecture in `TitleShield System Architecture` (the blueprint). [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) maps each section of the blueprint to the code and lists where the implementation differs.

---

## Quick start (Mac with Postgres.app)

You need **Node.js 20+** and **Postgres.app** running.

```bash
createdb titleshield     # once
npm install
npm run dev              # API on :8080, web app on :5173
```

Open **http://localhost:5173**, sign in, go to **Settings** and paste your free TinyFish key (get one at https://agent.tinyfish.ai/api-keys, no card needed). Press **Test**. That's all the setup.

A `.env` file is optional. If your Postgres needs a user name, create `.env` with one line:

```
DATABASE_URL=postgres://YOUR_MAC_USER@localhost:5432/titleshield
```

Every demo account uses the password `demo1234`.

| Account | Can do |
|---|---|
| `buyer@demo.in` | Run searches, open and fund escrows |
| `advocate@demo.in` | Review conditional titles and approve or reject them |
| `bank@demo.in` | Bank officer view |
| `admin@demo.in` | Everything, plus changing keys and anchoring the ledger |

### Full stack in Docker (as the blueprint specifies)

This runs PostgreSQL 16, Temporal, MinIO with S3 Object Lock, the API and web app, and a Temporal worker.

```bash
cp .env.example .env
docker compose up --build
```

App at **http://localhost:8080**, Temporal UI at **http://localhost:8233**, MinIO console at **http://localhost:9001**.

---

## Walkthrough (5 minutes, all live)

[demo/WALKTHROUGH.md](demo/WALKTHROUGH.md) has the exact inputs for three escrows:

- **A. Verified clean.** The contract releases the tokens to the seller.
- **B. Qualifying defect** (an unreleased mortgage in the EC). The contract refunds the buyer.
- **C. Inconclusive.** The tokens stay locked. Forged, expired and replayed verdicts are refused. An advocate resolves it.

The specimen records for A and B are in `demo/`.

## Web3 escrow (smart contract)

| | |
|---|---|
| Contracts | [`contracts/TitleEscrow.sol`](contracts/TitleEscrow.sol) and [`contracts/TestToken.sol`](contracts/TestToken.sol) (mock ERC-20 "TST", no monetary value), Solidity 0.8.26 |
| Chain | `npm run dev` starts a local EVM test chain inside the API (chain ID 1337, JSON-RPC on `localhost:8545`) and deploys both contracts. For a public testnet such as Sepolia, with Etherscan links and MetaMask, see [docs/REVISION.md §8](docs/REVISION.md#8-running-and-demonstrating). |
| Flow | e-signed → `createEscrow()` · buyer `approve()` + `deposit()` (tokens move into the contract) · search starts → `beginVerification()` · oracle signs an EIP-712 verdict → `settle()` releases, refunds, or marks the escrow disputed |
| Rules enforced on-chain | A verdict counts only if the oracle signed it, it names this escrow and search, it hasn't expired, and its nonce is unused. Clean release needs a score of 90+ (or an advocate's review after a dispute). Inconclusive moves nothing. A settled escrow can't be settled again. After the deadline, an unsettled deposit can only go back to the buyer. |
| Where to see it | The **Smart contract escrow** card on each escrow (wallets, signed verdicts, transactions, security-check buttons), and the explorer at `/chain` |

`npm run contracts` recompiles the Solidity. A test checks that the committed bytecode matches the source.

## Running a search on a real address

1. **New search.** Type the address, for example your own flat. Pick a suggestion or press **Find on map**. The state, district, taluk, village and PIN fill in, and you can correct any of them or click the map.
2. **Owner name.** Enter the seller or owner as written on the documents. The survey number is optional; it is on the sale deed, the property tax receipt or the RTC / 7-12, and it makes every check sharper.
3. **Official records (recommended).** Download the EC and the RoR from the state portals linked on the page, and upload them. Digital PDFs are read directly. Scans and photos need the optional free Gemini key in Settings.
4. **Run.** The four agent cards show each search query, each page read, and each finding with its strength.

How to read the result:

| Result | Meaning |
|---|---|
| **Clear, 90–100** | EC and RoR uploaded, owner matches, no court case, bank notice or acquisition notice found |
| **Conditional, 50–89, advocate review** | Something could not be confirmed: no EC or RoR, an incomplete web check, or a finding that names the owner and place but not the survey number |
| **Defective, below 50 or vetoed** | An open mortgage or bank notice (V1), a court injunction (V2), or an acquisition or prohibition order (V3) on this property |

Without the EC and RoR a search cannot clear on its own; it goes to an advocate. That is deliberate: a web search alone is not proof of clean title. Click **Re-check with EC & RoR** after uploading them.

### Findings and their strength

| Strength | When | Effect |
|---|---|---|
| **Strong** | The page has the survey number (with a survey keyword) and the village or locality | Scored; can trigger a veto |
| **Medium** | The page names the owner and the place or district, but not the survey number | Score capped at 89, sent to an advocate (rule G5) |
| **Weak** | Same area only | Shown for reference, not scored |

### Free-tier limits

TinyFish's published free limits: Search 30 per minute and 500 per hour; Fetch 150 URLs per minute and 1,000 per day. A search uses about 8–12 Search calls and up to 18 page fetches. The app counts every call, never goes over the limits (it waits and tells you on screen), and reuses results for 12 hours. Usage is shown on the Settings page.

OpenStreetMap's Nominatim allows one request per second, so the app spaces those calls.

---

## Other things to try

- **Escrow.** See the walkthrough above, or *Escrow → New escrow* with any address. Both parties eSign (the sandbox shows the OTP), upload the EC and RoR, then deposit test tokens from the demo wallet or MetaMask. (With `CHAIN_MODE=off` the older sandbox-bank rail with UPI/NEFT/RTGS is used instead.)
- **Monitoring.** After release, *Run monitoring check now* re-runs the court, bank-notice and government-notice searches and raises an alert for anything new.
- **Advocate.** Sign in as `advocate@demo.in` to approve or reject conditional titles. Approval issues the certificate and releases the escrow.
- **Verify.** Upload a downloaded certificate PDF on *Verify certificate*. Change one byte and it no longer matches. Adobe Reader shows the digital signature as an untrusted issuer, because it is a development certificate.
- **Bank API.** The *Bank API* page sends a real `X-API-Key` request and shows the `202 Accepted`, polling, and the HMAC-signed webhook.

## Architecture in one picture

```
Web app (React) ─┐                    ┌─ Location: OpenStreetMap (Photon, Nominatim) + India Post PIN API
Bank systems ────┼─► Fastify API ─────┼─ TinyFish Search + Fetch (free tier) ─► court records,
Advocates ───────┘   auth · rate limit│   bank notices, government notices · rate limiter + 12 h cache
                     idempotency ·    ├─ Records: uploaded EC / RoR / deed → PDF text layer or Gemini
                     DPDP audit · SSE ├─ Vernacular: Kruti Dev decoder · Indic transliteration ·
                          │           │   IndicSoundex / patronymic name matching
                   Temporal saga      ├─ Deterministic rule engine (vetoes, deductions, guardrails)
                   (or inline engine) ├─ TCC: PDF + PAdES signature · WORM evidence · hash-chained
                          │           │   ledger · hourly Merkle root + RFC 3161 timestamp
                     PostgreSQL 16    ├─ Escrow: state machine · Aadhaar eSign · trustee bank with
                                      │   whitelisted payees · Ed25519 oracle-signed payouts · monitoring
                                      └─ Web3: TitleEscrow + TST test token; EIP-712 oracle verdicts; local EVM chain or testnet
```

## Project layout

```
packages/core/        Pure domain logic, unit-tested: schemas, scoring, page matching and
                      extraction, mortgage matching, chain of title, name resolution,
                      transliteration, Kruti Dev decoder, hash chain, Merkle, state registry
apps/server/          Fastify API, Temporal worker, migrations, TinyFish Search/Fetch client,
                      geocoding, web agents, document reading, escrow + sandbox bank,
                      PDF certificates, ledger
contracts/            Solidity: TitleEscrow (holds the deposit, verifies signed verdicts) and TestToken (TST)
demo/                 Walkthrough inputs and specimen records
apps/web/             React app: address search with map, live run, settings, escrow, blockchain explorer,
                      advocate console, verify, ledger, bank API
docs/ARCHITECTURE.md  Blueprint section → code mapping, and deviations
docker-compose.yml    Full stack
```

## Tests

```bash
createdb titleshield_test   # once; the suite uses its own database
npm test                    # 33 core + 14 contract + 23 end-to-end tests
npm run typecheck
```

The end-to-end suite runs the API against local stand-ins that answer in the published formats of TinyFish Search and Fetch, Nominatim, Photon, India Post and Gemini. It checks:

- behaviour with no key, and saving and testing keys from Settings
- resolving a typed address, and a medium-strength court finding
- vetoes V1 (bank possession notice), V2 (injunction) and V3 (acquisition notification)
- a clean 100 from uploaded EC and RoR PDFs read without AI, and the Gemini path
- caching, SSE streaming, the bank API's idempotency and signed webhook
- escrow release with the fee split, monitoring alerts, refunds and advocate review
- the penny-drop mismatch, a forged-signature payout being refused, and PDF tamper detection
- URL validation before Fetch, `INCOMPLETE` checks, the credit budget, and the step-by-step diagnostics
- the TitleEscrow contract: deposit custody, clean release, defect refund, and rejection of forged signers, replays, expired verdicts, wrong-escrow verdicts and double settlement; inconclusive verdicts keep the funds locked
- scenarios A–E end to end, including the MetaMask path, where the server confirms the deposit on-chain

Set `TEST_DATABASE_URL` to use a different test database.

## Main API

| Method | Path | |
|---|---|---|
| POST | `/api/v1/title-search/execute` | Start a search from an address (`addressText`, `ownerName`, optional `surveyNumber`, `pincode`, `latitude`, `longitude`). Streams SSE for retail; returns `202` for `X-API-Key` callers. Supports `Idempotency-Key`. |
| GET | `/api/v1/title-search/:id` · `/:id/events` | Result · live event stream |
| POST | `/api/v1/title-search/:id/documents` | Attach EC / RoR / deed files |
| GET · POST | `/api/v1/geo/suggest` · `/geo/resolve` · `/geo/reverse` | Address suggestions, address → location, map point → location |
| GET · PUT · POST | `/api/v1/settings` · `/settings/test` | Keys and free-tier usage |
| GET | `/api/v1/chain` · `/chain/tx/:hash` · `/chain/source` · `/escrow/:id/chain` | Block explorer: contracts, transactions, events, source, one escrow on-chain |
| POST | `/api/v1/escrow` · `/:id/esign/:party/start` · `/verify` · `/:id/deposit` | Escrow lifecycle |
| POST | `/api/v1/webhooks/bank` | Trustee bank → TitleShield (HMAC-signed) |
| POST | `/api/v1/advocate/:searchId/decision` | Advocate approves or rejects |
| GET | `/api/v1/verify/:certId` · POST `/api/v1/verify/upload` | Public verification |
| GET | `/api/v1/ledger` · `/api/v1/certificates/:id.pdf` | Ledger and certificates |

## What is sandboxed

These parts need contracts or licences, so they sit behind adapters with working sandboxes:

| Part | Sandbox in this repo | What production needs |
|---|---|---|
| Trustee bank (Castler / Cashfree Escrow / Yes Bank) | Separate ledger tables, virtual accounts, UPI/NEFT/RTGS rules, signed webhooks, oracle-signature checks | The bank's API contract, behind the same interface |
| Aadhaar eSign | OTP flow, shown on screen in sandbox | A licensed ESP |
| Class-3 DSC | A locally generated development certificate. The PDF signature is real and verifiable, but the issuer isn't a licensed CA. | A CCA-issued document-signer certificate in an HSM |
| Penny drop | Verifies the account holder's name | Penny-drop API |

## Licence

Prototype for evaluation. Land records are public, but how you access them is governed by each portal's terms. Web findings are leads for a buyer or advocate to check, not legal opinions.
