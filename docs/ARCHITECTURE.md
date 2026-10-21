# Blueprint → implementation map

Each row is a section of the TitleShield architecture blueprint and where it lives in the code.

| Blueprint § | Requirement | Implementation |
|---|---|---|
| 1.2, 3.1 | Multi-source extraction via TinyFish | Free tier only: `apps/server/src/tinyfish/client.ts` (Search + Fetch, rate limiter, cache, usage counters), `agents/webAgents.ts` (court, bank-notice and government-notice agents), `agents/records.ts` (EC / RoR) |
| 1.3 | ≤ 60 s P95, 500 concurrent sessions | Agents run in parallel; `maxConcurrentActivityTaskExecutions: 500` in `worker.ts`. On the free tier a search can wait for the published per-minute limit, and the UI says so |
| 2 | API gateway: rate limit, mTLS, idempotency, DPDP audit | `apps/server/src/app.ts` (rate limit, audit hook), `http/auth.ts` (mTLS header from gateway), idempotency in `routes/search.ts` |
| 2 | Temporal saga orchestration | `workflows/logic.ts` (saga), `workflows/temporal/workflows.ts`, `worker.ts`; inline engine in `workflows/engine.ts` |
| 3.1 | district-rent-shark: geo hierarchy | `geo/geocode.ts` (Photon suggestions, Nominatim search / reverse, India Post PIN lookup → state, district, taluk, village); `packages/core/src/portals.ts` (all states and UTs: hierarchy names, revenue and EC portals, High Court, RERA) |
| 3.1 | tenders-finder: 4 parallel agents | `Promise.all` fan-out over `AGENT_ROLES` (RECORDS, COURTS, BANK_NOTICES, GOVT_NOTICES) in `workflows/logic.ts` |
| 3.2 | Strict output schema (Zod) | `packages/core/src/schemas.ts` (`PortalExtractionSchema`, `FindingSchema`, `SourceLogSchema`) |
| 3.3 | Versioned goal prompts | Replaced by versioned query plans: `webAgents.ts → plan(role, query, state)`; every query sent is stored in `agent_runs.search_log` |
| 3.4 | Vault, Fetch, Monitor | Fetch: used for every page read. Vault and Monitor are paid, so not used (see deviations) |
| 4.1 stage 1 | Font transcoder (Kruti Dev …) | `packages/core/src/fonts/krutidev.ts`, applied in `docai/vernacular.ts` |
| 4.1 stage 1–2 | Indic OCR + vision LLM | `docai/pdftext.ts` (digital PDF text layer, no AI) and `docai/gemini.ts` (optional, scans and photos) |
| 4.1 stage 2 | IndicSoundex + Levenshtein + patronymic matching | `packages/core/src/names/{transliterate,phonetic,resolver}.ts`; page matching in `packages/core/src/matching.ts` |
| 4.1 stage 3 | 30-year chain-of-title DAG, break detection, mortgage-release matching | `packages/core/src/chain.ts`, `mortgages.ts`; EC / RoR text parsing in `extract.ts` |
| 5.1 | Canonical output JSON | `TitleClearanceOutput` in `schemas.ts`, built in `activities.ts → issueCertificate` |
| 5.2 | `S = max(0, 100 − Σwᵢ·Iᵢ) × Π(1 − Vₖ)`, vetoes V1–V3, weights 15/5/10/20, thresholds 90/50 | `packages/core/src/scoring.ts` |
| 6.1–6.2 | Regulated escrow, tri-party Aadhaar eSign, state machine | `escrow/service.ts` (states exactly as the blueprint's SQL CHECK) |
| 6 (Web3) | Title escrow smart contract: holds the advance, unlocks only on a clean certificate, reverts on a lien | `contracts/TitleEscrow.sol`, `contracts/TitleShieldINR.sol`; `apps/server/src/chain/chain.ts` (local EVM node, deploy, signing, event decoding) and `chain/escrowChain.ts` (open / fund / release / refund / hold / redeem wired into `escrow/service.ts`); explorer in `routes/chain.ts` and web `pages/Chain.tsx` |
| 6.3 | Whitelisted payees + HSM-backed oracle attestation | `escrow/oracle.ts` (Ed25519), `escrow/sandboxBank.ts` (verifies signature, nonce, payee, balance, idempotency) |
| 7.1 | WORM evidence `.tar.zst`, 15-year Compliance lock | `storage/worm.ts` (S3 Object Lock COMPLIANCE; MinIO in docker). Every search query and fetched page is kept as evidence |
| 7.2 | Hash-chained ledger, hourly Merkle root, RFC 3161 TSA | `packages/core/src/hashchain.ts`, `ledger/ledger.ts`, `certs/tsa.ts`; a DB trigger makes the ledger append-only |
| 7.3 | Class-3 DSC signature on the TCC PDF | `certs/tcc.ts` (PAdES via @signpdf), `crypto/pki.ts` |
| 8 | PostgreSQL 16 schema | `db/migrations/001_blueprint_schema.sql` is the blueprint SQL verbatim; `002_platform.sql` and `003_free_tier.sql` extend it |
| 9.1 | `POST /api/v1/title-search/execute`, SSE stream, B2B API key | `routes/search.ts`, `http/sse.ts` |
| 10.1 | Self-healing navigation | No CSS selectors anywhere: pages are found by search and read as markdown |
| 10.2 | Stale-while-revalidate cache | `web_cache` table (12 h, failed fetches included); monitoring and escrow re-checks bypass it |
| 10.3 | Circuit breaker, 202 + webhook, backoff retries | Free-tier limiter waits instead of failing; `RATE_LIMITED` / `FAILED` agents retried after 65 s in `logic.ts`; `webhooks/outbound.ts` |
| 10.4 | HITL advocate queue, 2-hour SLA | `advocate_reviews`, `routes/trust.ts`, web `pages/Advocate.tsx` |
| 11 | 0.25% escrow fee | `PLATFORM_FEE_BPS=25`; fee charged on release only, refunds are 100% |
| 12 | Data localisation, DPDP consent, AES-256-GCM PII, prompt-injection isolation | Region via deployment; `consent_artifacts`; `crypto/secrets.ts` (account numbers and saved API keys encrypted); page and document text is treated as data, never as instructions |

## Where the implementation differs from the blueprint, and why

1. **TinyFish free tier only.** The blueprint drives a browser agent (TinyFish Agent API) through each government portal. That product is paid per step, so this build uses only TinyFish's free products:
   - **Search** finds pages about the property: court records (Indian Kanoon, eCourts and High Court sites), SARFAESI notices from banks and newspapers, and gazette and acquisition notifications.
   - **Fetch** reads those pages as markdown. Rules in `packages/core/src/matching.ts` and `extract.ts` decide what each page says about this property.
   - No call is made to Agent, Browser or Monitor. The client enforces the published free limits and caches results to stay inside them.
2. **Land records are uploaded, not scraped.** State EC and RoR portals sit behind logins, captchas and form flows that need the paid browser agent. The Records agent therefore reads the EC and RoR the user downloads from the official portal (links per state on the page). Without them a search cannot clear automatically (guardrail G3) and goes to an advocate.
3. **Any address, survey number optional.** The blueprint's input is a survey number. Here the input is an address, resolved with OpenStreetMap and India Post. When there is no survey number, checks run on the owner's name and locality, and findings carry a strength:
   - **Strong:** survey number plus place. Scored, and can trigger a veto.
   - **Medium:** owner plus place. Triggers the new guardrail **G5**, which caps the score at 89 and sends it to an advocate.
   - **Weak:** shown in the UI only.
4. **Monitoring.** TinyFish Monitor is paid. Daily escrow monitoring is a scheduled workflow that re-runs the court, bank-notice and government-notice searches with the cache bypassed, and compares the finding URLs with the baseline taken at release.
5. **CAPTCHAs.** Nothing in this build attempts to defeat a CAPTCHA or log in to a portal.
6. **Dharani** was replaced by **Bhu Bharati** in April 2025. The portal code stays `DHARANI_TS`, as in the blueprint, but the link points to Bhu Bharati.
7. **AWS QLDB** (blueprint §1.2) has been discontinued by AWS. The PostgreSQL hash-chained ledger (§7.2) covers that role, made append-only by a database trigger.
8. **Evidence Act sections.** §7.3 cites Sections 65B and 85B of the Indian Evidence Act. The Bharatiya Sakshya Adhiniyam, 2023 replaced that Act and renumbered these provisions; 65B is now Section 63. Confirm the citations with counsel before using them in customer-facing text.
9. **Guardrails added.** The blueprint flags some conditions without giving them a weight. Each of these caps the score at 89, so the property can never auto-clear and goes to an advocate. The PDF certificate lists them as rules G1–G5:
   - **G1:** a chain-of-title break.
   - **G2:** a seller who isn't the owner on record.
   - **G3:** a missing EC or RoR, or an incomplete web check.
   - **G4:** a pending case without a stay.
   - **G5:** a medium-strength finding.
10. **Orchestration.** Temporal is the production engine (`WORKFLOW_ENGINE=temporal`). The same saga can also run in-process (`inline`), so the project runs and is tested without extra services.
11. **Document AI.** The blueprint names Surya / Document AI followed by Gemini. This build reads digital PDFs from their text layer with no AI at all, and uses Gemini's free tier (optional) for scans and photos. A dedicated OCR stage can be added in front of it in `docai/`.
12. **Smart-contract escrow.** The advance is mirrored on-chain as tINR, a token backed 1:1 by the trustee bank's escrow account. The bank stays the regulated custodian of the rupees, and the contract is the programmable rulebook everyone can verify. The bank mints tINR when the advance arrives and burns it when it pays out, so the on-chain supply always equals the money held. The contract is settled first: if it refuses (for example `TitleNotClear`), the bank is never asked to pay. By default the chain is a local EVM node inside the API, so the project runs offline; `CHAIN_MODE=rpc` deploys the same contracts to any EVM network.
13. **Walkthrough properties.** The two properties in `demo/WALKTHROUGH.md` replay recorded TinyFish Search + Fetch responses (`tinyfish/recorded.ts`) so the demo is reproducible. They go through the same agents, matching and scoring code as live runs, and the evidence file of each run records which source was used.
