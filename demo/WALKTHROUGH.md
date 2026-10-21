# Walkthrough: smart-contract escrow + TinyFish checks

Two properties show both outcomes of the TitleEscrow contract. Their TinyFish Search + Fetch responses are
recorded (see `apps/server/src/tinyfish/recorded.ts`), so the demo comes out the same every time and works
without internet. Any other address runs live against the TinyFish API. Set `DEMO_PROPERTIES=false` to make
these two live as well.

Sign in as `buyer@demo.in` / `demo1234`, then go to **Escrow → New escrow**.

## 1. Clean title: the contract unlocks the advance to the seller

| Field | Enter |
|---|---|
| Property address | `Chandivali, Andheri East, Mumbai 400072`, then pick the suggestion or press **Find on map** |
| Survey / Gat no. | `28/4` |
| Agreed sale price | `12000000` (advance 10% = ₹12,00,000) |
| Buyer | `Priya Sharma` · `50100234567891` · `HDFC0001234` |
| Seller | `Rohan Mehta` · `001234567890` · `ICIC0000123` |

1. Tick consent, then **Open escrow account**.
2. Sign as buyer and as seller: enter any four digits, then **Send OTP**. Type the OTP shown on screen and press **Sign**. The **Smart contract** card shows the `open()` transaction.
3. Under **Add the official records**, choose `demo/EC_Chandivali_CTS-28-4.pdf` as the EC and `demo/PropertyCard_Chandivali_CTS-28-4.pdf` as the Record of Rights. Then press **Upload records**.
4. Press **Pay by RTGS**. The deposit is locked in the contract (`fund()`).
5. TinyFish runs its checks and the score comes out as 100. The contract runs `release()`: ₹11,97,000 goes to the seller and ₹3,000 is the fee. The tINR is then redeemed as the bank pays out.

## 2. Undisclosed bank lien: the contract refunds the buyer

| Field | Enter |
|---|---|
| Property address | `Kandivali West, Mumbai 400067` |
| Survey / Gat no. | `112/7` |
| Agreed sale price | `8000000` (advance ₹8,00,000) |
| Buyer | `Priya Sharma` · `50100234567891` · `HDFC0001234` |
| Seller | `Suresh Patil` · `009876543210` · `SBIN0004567` |

1. Sign both parties as before. Don't upload any records.
2. Press **Pay by RTGS**.
3. The TinyFish bank-notices agent finds a SARFAESI possession notice for C.T.S. No. 112/7. That triggers veto V1 and a score of 0. The contract runs `refund()`, which returns the full ₹8,00,000 to the buyer.

Open **Blockchain** in the top bar to see the contracts, every transaction, the decoded events and the Solidity source.
