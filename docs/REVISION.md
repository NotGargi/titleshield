# TitleShield revision: TinyFish Search + Fetch and attestation-verified smart-contract escrow

This revision follows the *Architecture Revision Policy: Minimal Changes Only* and the *TitleShield (BhoomiTrust) Implementation Blueprint*. The existing application is the baseline. Only the TinyFish integration layer, the escrow settlement path and the screens that show them changed.

---

## 1. What was inspected and what was found

| Area | Finding before this revision |
|---|---|
| TinyFish client | Already used only Search (`GET api.search.tinyfish.ai`) and Fetch (`POST api.fetch.tinyfish.ai`); no Agent, Browser, Vault or Monitor code anywhere. **Defect:** every Fetch request carried an undocumented field (`page_metadata`) that a strict API rejects with HTTP 400. The client timeout (60 s) was shorter than TinyFish's documented 120 s batch ceiling, and HTTP 403 was misreported as an invalid key. |
| Search → Fetch pipeline | Search results went to Fetch after ranking, but without explicit URL validation (no private, local or malformed-URL check, no allowlist for open-web queries) and duplicates were matched only on the exact string. |
| Retrieval status | A check where every page failed to load still ended as `SUCCESS`, so an empty retrieval could look like a clean check. |
| Credit use | Caching and rate limiting existed; there was no overall credit budget. |
| Recorded demo runs | Two walkthrough properties replayed saved TinyFish responses by default, with nothing on screen saying so. |
| Escrow contract | The trustee bank minted a rupee-labelled token into the contract; the buyer never deposited anything. Settlement was an `onlyOracle` function call. There was no signed attestation, no expiry, no nonce and no search binding. Inconclusive results used an on-chain "hold", but release after review relied on a free-form flag. |
| Risk engine | Already sound: `REJECTED` happens only when a veto fires (deduction weights cannot push a score below 50 on their own), and a clean verdict needs the EC, the RoR and every web check (guardrail G3). It maps directly to *qualifying defect / verified clean / inconclusive*, so it needed no change. |

## 2. Change-impact table

| Existing component | Current role | Action | Reason |
|---|---|---|---|
| Frontend (React) | User journey, progress, results | **Preserved**; small additions | Deposit step uses the contract; contract card shows signed verdicts and security checks; Settings shows credits and diagnostics; "Incomplete" and "Recorded replay" labels; outcome wording |
| Backend APIs | Orchestration | **Preserved**; 4 endpoints added, 1 extended | `POST /escrow/:id/deposit` accepts `mode: "CHAIN"`; new `/escrow/:id/chain/faucet`, `/chain/confirm-deposit`, `/chain/security-check`, `/settings/diagnostics`. No field removed |
| TinyFish integration (`tinyfish/client.ts`, `agents/webAgents.ts`) | Data collection | **Modified** | Documented Fetch fields only; 150 s timeout; 400/401/402/403 mapped correctly; response-shape validation; empty pages treated as failures; URL validation step; credit budget; `INCOMPLETE` status; diagnostics |
| Evidence processing (matching, extractors, OCR / PDF text) | Extraction and validation | **Preserved** | Unchanged; partial evidence from an incomplete check is still read, so a defect it found still counts |
| Risk engine (`packages/core/scoring.ts`) | Title-risk assessment | **Preserved** | Already gives clean / defect / inconclusive with the right guardrails |
| Database and audit trail | Persistence | **Extended** (migration `005`) | New `verification_attestations` table; `funding_rail` column; `INCOMPLETE` allowed in the agent-run status check |
| Bank escrow workflow (sandbox trustee bank) | Previous escrow | **Kept only for `CHAIN_MODE=off`** | The contract is now the escrow. Bank deposit modes return 409 while the contract is on; the sandbox and its signed-payout checks remain for the off mode and their tests |
| Solidity escrow contract | On-chain custody | **Replaced** (`contracts/TitleEscrow.sol`) | The buyer deposits tokens, and the contract verifies an EIP-712 oracle attestation bound to escrow, search, evidence hash, expiry and nonce. It adds a reentrancy guard, checks-effects-interactions, an explicit state machine and oracle rotation |
| Token | Asset | **Replaced** (`contracts/TestToken.sol`) | Mock ERC-20 "TitleShield Test Token" (TST) with a capped faucet. It no longer claims to be rupees or bank-backed |
| Verification attestation (`chain/attestation.ts`) | — | **Added** | Signs EIP-712 verdicts with the oracle key. The key never leaves the backend and never sends transactions |
| Oracle policy (`decideOutcome` in `chain/escrowChain.ts`) | — | **Added** | Signs *verified clean* only for a clean verdict or an advocate's approval, and *qualifying defect* only for a veto or an advocate's rejection. Everything else is *inconclusive* |
| Deployment (Render, Docker) | Hosting | **Preserved** | Optional testnet variables; `SETTINGS_LOCKED` for the public demo |

## 3. Revised architecture

```
                    RETAINED                          MODIFIED                              NEW
┌────────────┐   ┌──────────────────┐   ┌───────────────────────────────────┐
│  React UI  │──►│ Fastify API      │──►│ TinyFish layer (Search + Fetch)    │
│ (+ wallet) │   │ auth · SSE ·     │   │ query plan → Search → URL checks → │
└─────┬──────┘   │ audit · workflow │   │ Fetch → status (SUCCESS/INCOMPLETE)│
      │          └───────┬──────────┘   │ cache · bounded retry · budget     │
      │                  │              └───────────────┬───────────────────┘
      │                  ▼                              ▼
      │          ┌──────────────────┐   ┌──────────────────────────────────┐
      │          │ Records reader   │   │ Matching + extractors (retained)  │
      │          │ PDF text / Gemini│──►│ Rule engine V1–V3, D1–D4, G1–G5   │
      │          └──────────────────┘   └───────────────┬──────────────────┘
      │                                                 ▼
      │                                 ┌──────────────────────────────────┐   NEW
      │                                 │ Oracle policy + EIP-712 signer    │  (oracle key: signs only)
      │                                 │ verified clean / defect / inconcl.│
      │                                 └───────────────┬──────────────────┘
      │  deposit (approve + deposit)                    │ settle(verdict, signature)
      ▼                                                 ▼ (relayed by the operator; anyone may relay)
┌───────────────────────────────────────────────────────────────────────────┐   REPLACED
│ TitleEscrow.sol  Created → Funded → VerificationPending ─┬─► Released     │
│ holds TST        (deposit)  (operator: beginVerification) ├─► Refunded     │
│                                                           └─► Disputed ──► Released / Refunded
│ checks: signer == oracle · escrowId/searchId match · not expired · nonce unused · state │
└───────────────────────────────────────────────────────────────────────────┘
Evidence bundle (WORM) · certificate PDF · hash-chained ledger: retained; the verdict's evidence hash links them to the chain.
```

**Trust boundaries:**
- The **frontend** can deposit and can ask for security checks, but it can never submit a trusted verdict.
- The **TinyFish layer** never touches funds.
- The **operator key** can create escrows and relay transactions, but cannot move escrowed tokens.
- The **oracle key** only signs. A single oracle is a documented prototype trust assumption. Production would need an HSM, independent verification and possibly several signers.

## 4. New dependencies

| Dependency | Where | Why it is needed |
|---|---|---|
| `ethers@6` | web app | MetaMask path only. The buyer's own wallet signs `approve()` and `deposit()` in the browser. It was already a server dependency. |

No new services, databases or AI models were added. The local EVM chain (`ganache`, already present) remains the zero-setup default. Any public EVM testnet works through `CHAIN_MODE=rpc` (section 8).

## 5. Data flows and API contracts (only what changed)

**Escrow (contract on, the default):**

1. **Both parties e-sign.** The operator calls `createEscrow(escrowId, searchId, seller, amount, fee, agreementHash, propertyHash, deadline)`.
2. **The buyer deposits**, in one of two ways:
   - **Demo wallet:** `POST /api/v1/escrow/:id/deposit {mode:"CHAIN"}`. The server runs the faucet (plus gas), then `approve()`, then `deposit()`, with the buyer's demo-wallet key signing.
   - **MetaMask:** `POST /api/v1/escrow/:id/chain/faucet {address}`. The wallet then calls `approve()` and `deposit()` itself, followed by `POST /api/v1/escrow/:id/chain/confirm-deposit`. The server reads the contract and never takes the browser's word.
3. **Verification starts.** The server moves the escrow to `FUNDS_LOCKED`, then `VERIFICATION_IN_PROGRESS`, calls `beginVerification()`, and starts the title search.
4. **The search finishes.** `decideOutcome()` picks the outcome, the oracle signs, and `settle(verdict, signature)` applies it:

   | Outcome | Contract action | Escrow state |
   |---|---|---|
   | Verified clean | Release to seller | `RELEASED_TO_SELLER` |
   | Qualifying defect | Refund to buyer | `REFUNDED_TO_BUYER` |
   | Inconclusive | Disputed; tokens stay locked | `DISPUTE_HOLD` |

5. **Advocate decision.** A new attestation is signed with `advocateReviewed: true`, and the contract releases or refunds.

**Attestation (EIP-712):**
- Domain: `TitleShieldEscrow` / version `1` / chain ID / contract address.
- Type: `Verdict(bytes32 escrowId, bytes32 searchId, uint8 outcome, uint16 score, bytes32 evidenceHash, bool advocateReviewed, uint64 issuedAt, uint64 expiresAt, bytes32 nonce)`.
- Default lifetime: 15 minutes (`ATTESTATION_TTL_SECONDS`).
- The evidence hash is the SHA-256 of the evidence bundle for a certificate, or of the canonical assessment for an inconclusive hold.
- Every signed attestation is stored in `verification_attestations`, with its status and transaction hash.

**TinyFish check statuses:**

| Status | When |
|---|---|
| `SUCCESS` | Searches ran and the selected pages were read |
| `INCOMPLETE` | No search completed; or no selected page could be read; or a page whose snippet points at this property couldn't be read; or the budget, allowance or 402 stopped it |
| `NOT_CONFIGURED` | No key |
| `RATE_LIMITED` | 429 after retries |

Any non-`SUCCESS` web check triggers guardrail G3, so the title can never be verified clean. Each `search_log` entry now also has `rejected[] {url, reason}`, `retrievedAt`, `ok` and `error`.

## 6. Migration plan (keeps existing data)

1. `005_attested_escrow.sql` runs automatically at start-up. It only adds a table, a nullable column and a wider status check. Nothing is dropped.
2. New contract versions are registered as `TestToken@1` and `TitleEscrow@2` in `chain_contracts`, so a running chain gets fresh contracts instead of reusing the old ones.
3. Escrows created before this revision keep their state and history. Their on-chain record belonged to the old contract, so they are shown as not on chain. New escrows use the new contract.
4. Title searches, certificates, the ledger and evidence are untouched.
5. Rollback: set `CHAIN_MODE=off` to return to the sandbox-bank rail. The schema additions are harmless when unused.

## 7. TinyFish Search and Fetch: how credits are conserved

- **Request format.** The client sends only documented parameters: `query`, `purpose`, `include_domains`, `location=IN`, `language=en`, `page` for Search; `urls` (at most 10), `format`, `purpose`, `per_url_timeout_ms` for Fetch.
- **Response checks.** Responses are checked for the documented `results` array before use.
- **URL validation.** Malformed URLs, non-HTTP schemes, embedded credentials, raw or private IPs, localhost/`.local`/`.internal` hosts and metadata endpoints are all rejected. URLs outside the requested domains, and duplicates (after normalisation), are dropped. Open-web bank-notice results are kept only if their snippet already names this property or they come from an auction site.
- **Fetch selection.** Fetch reads at most `PAGES_PER_AGENT` pages per check, preferring pages whose snippet matches.
- **Cache.** Results are cached for `WEB_CACHE_HOURS`, failed fetches included. Monitoring and escrow re-checks bypass the cache.
- **Retries.** Retries are bounded: at most 3 attempts, only for 429, 5xx and network errors. The workflow never retries an `INCOMPLETE` check.
- **Budget.** Every call is metered against `TINYFISH_CREDIT_BUDGET` (8,000 by default; 1 credit per search and 1 per successfully read page, configurable). The app stops before the budget would be exceeded.
- **Note on pricing.** TinyFish's current docs list Search and Fetch inside a free daily allowance: 12,000 searches a day, and 1,000 successfully fetched URLs a day, which reset at 00:00 UTC. Treat the 8,000 figure as this project's allowance, and set the per-call costs to match your dashboard.
- **Live diagnostics.** *Settings → Run step-by-step diagnostics* runs Search alone, then Fetch of a known public page, then a Search result passed into Fetch. It shows exactly what TinyFish returned at each step (blueprint Phase 1).
- **What Search and Fetch can't do.** They can't log in, fill forms or solve CAPTCHAs, so state EC and RoR portals can't be retrieved this way. The owner uploads those records, with links to the official portals, and the app says so. A missing or unreadable record is never treated as clean.
- **Recorded replays.** These are off by default (`DEMO_PROPERTIES=false`). When switched on, they are labelled *Recorded replay* on screen and in the evidence file.

## 8. Running and demonstrating

**Local (default: local EVM test chain, nothing to configure):**

```bash
npm install
npm run dev                  # http://localhost:5173
```

1. Sign in as `admin@demo.in` / `demo1234`.
2. In **Settings**, paste the TinyFish key and press **Run step-by-step diagnostics**.
3. Follow [demo/WALKTHROUGH.md](../demo/WALKTHROUGH.md):
   - **Scenario A:** verified clean, then release.
   - **Scenario B:** qualifying defect, then refund.
   - **Scenario C:** inconclusive, funds stay locked, the security checks all refuse, then an advocate resolves it.

**Public EVM testnet (e.g. Sepolia), for explorer-verifiable transactions:**

1. Create two wallets: an **operator** (fund it with test ETH from a Sepolia faucet) and an **oracle** (needs no ETH; it only signs).
2. Set these variables in `.env`, or in Render → Environment:

   ```
   CHAIN_MODE=rpc
   CHAIN_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
   CHAIN_OPERATOR_KEY=0x…        # funded
   CHAIN_ORACLE_KEY=0x…
   CHAIN_EXPLORER_URL=https://sepolia.etherscan.io
   ```

3. Restart. On first start, the operator deploys `TestToken` and `TitleEscrow`. Every transaction link then opens Etherscan, and **Deposit with MetaMask** works from any browser.
4. Each demo-wallet escrow uses about 0.002 test ETH for the buyer's gas.

**Tests:**

```bash
createdb titleshield_test
npm test      # 33 core + 14 contract + 23 end-to-end
```

| Blueprint §14 requirement | Test |
|---|---|
| Search returns parseable results; Fetch reads a known page; Search → Fetch | `diagnostics` (end-to-end) |
| Duplicates removed; invalid or unsafe URLs rejected; API failures give clear errors | `validates search results before Fetch…` |
| Inaccessible portal → no clean verdict | the same test, plus the no-key and budget tests |
| Repeated tests don't create unnecessary usage | `caches web results…`, `stops calling TinyFish when the credit budget is used up` |
| Buyer deposits; contract holds the deposit; clean releases the correct amount; defect refunds the correct amount | `TitleEscrow: custody`, `attested settlement` (contract), Scenarios A and B (end-to-end) |
| Unauthorised signer, replayed, expired and wrong-escrow attestations rejected; no double settlement | contract tests, plus Scenarios C, D and E (end-to-end security checks) |
| Inconclusive evidence doesn't release; dispute follows the policy | `inconclusive evidence keeps the tokens locked…`, Scenario C |

## 9. Limitations and trust assumptions

- **Coverage.** Search and Fetch can't retrieve records behind logins, forms or CAPTCHAs. Official EC and RoR come from the owner's upload, and a hash proves the evidence package hasn't changed, not that the source was complete.
- **Not a legal opinion.** *Verified clean* means clean under the configured checks: EC, RoR and every web check retrieved, with no veto. It is not a legal title opinion.
- **Oracle trust.** The contract enforces the verdict it accepts, but it can't judge whether the oracle read a document correctly.
- **Test assets only.** TST has no monetary value. Real-money custody needs a separate legal, regulatory and technical design.
- **Irreversible settlement.** Once the contract transfers tokens, it can't reverse the transfer, which is why inconclusive results never trigger an automatic transfer.
