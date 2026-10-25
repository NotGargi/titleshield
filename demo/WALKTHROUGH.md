# Walkthrough: Search → Fetch → verification → signed verdict → smart-contract escrow

Every step below runs live. TinyFish Search and Fetch are called with your key, the records are read from the PDFs, the oracle signs a real EIP-712 verdict, and the TitleEscrow contract moves the test tokens. The four PDFs in this folder are fictional specimen records, and each one says "Specimen" at the bottom.

**Before you start:**
1. Sign in as `admin@demo.in` / `demo1234`.
2. Go to **Settings**, paste your TinyFish key and press **Run step-by-step diagnostics**. All three steps should show ✓.

**For each scenario:**
1. Go to **Escrow → New escrow**.
2. For the address, type it, click the first suggestion, then press **Find on map**.
3. Use this buyer every time: `Priya Sharma` · `50100234567891` · `HDFC0001234`.
4. To sign, type any four digits, press **Send OTP**, type the OTP shown on screen, then press **Sign**.

## Scenario A: verified clean → the contract releases the tokens to the seller

| Field | Enter |
|---|---|
| Address | `Chandivali, Mumbai` |
| Survey no. | `28/4` |
| Sale price | `12000000` |
| Seller | `Vihaan Rajadhyaksha` · `001234567890` · `ICIC0000123` |

1. Open the escrow and sign both parties. The Smart contract card shows **Created**.
2. Upload `A_EC_Chandivali_CTS-28-4.pdf` (EC) and `A_PropertyCard_Chandivali_CTS-28-4.pdf` (Record of Rights).
3. Press **Deposit from the buyer's demo wallet**. The faucet, `approve()` and `deposit()` run, and the contract shows the tokens locked.
4. Click **Open live verification** to watch the four checks.
5. Expected result: **Verified clean, 100**. The card shows *Signed verdict: verified clean → release*, and the seller wallet receives 11,97,000 TST.

## Scenario B: qualifying defect → the contract refunds the buyer

| Field | Enter |
|---|---|
| Address | `Kandivali West, Mumbai` |
| Survey no. | `112/7` |
| Sale price | `8000000` |
| Seller | `Kabir Sabnis` · `009876543210` · `SBIN0004567` |

1. Upload `B_EC_Kandivali_CTS-112-7.pdf` and `B_PropertyCard_Kandivali_CTS-112-7.pdf`. The EC shows a 2022 mortgage that was never released.
2. Deposit from the demo wallet.
3. Expected result: veto V1 (active mortgage), **qualifying defect**. The contract refunds all 8,00,000 TST to the buyer's wallet.

## Scenario C: inconclusive → the tokens stay locked; forged verdicts are refused

| Field | Enter |
|---|---|
| Address | `Powai, Mumbai` (any address) |
| Survey no. | leave blank |
| Sale price | `9000000` |
| Seller | `Asha Kulkarni` · `001234567890` · `ICIC0000123` |

1. Don't upload any records, then deposit.
2. Expected result: guardrail G3 (records incomplete), **inconclusive**. The contract marks the escrow **Disputed** and the tokens stay locked.
3. Under **Security checks**, press **Forged signer**, **Expired verdict** and **Verdict for another search**. The contract refuses each one and shows the reason.
4. Sign in as `advocate@demo.in` and approve under **Advocate review**. The oracle signs a reviewed verdict, and the contract releases the tokens.
5. Back on the escrow, **Replay last verdict** is refused too.

## Optional: MetaMask

On a public testnet (see `docs/REVISION.md`, section 8), or when you run the app on `localhost`, **Deposit with MetaMask** lets your own wallet do the approve and deposit steps.
