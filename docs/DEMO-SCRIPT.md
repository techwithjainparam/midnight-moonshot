# PRIESTATE — Level 3 Demo Script & Recording Checklist

Concise recording guide for the official **Midnight Builder Challenge — Level 3** demo video (~1 minute). Every step below was verified against the deployed app, contract, terminal, and repository state.

## Demo URL / Entry Points

| Item | Exact value |
| ---- | ----------- |
| Live frontend | `https://priestate.vercel.app` |
| Landing page (start here) | `/` |
| Privacy / circuit operation route | `/verify/reg-001` |
| Result screen route | `/verification/reg-001` |
| Network | Midnight **Preprod** |
| Deployed contract address | `fe251d3c8c26ccd56255a636c205c6b804489dbbaf41ddf316244ceb7f3159c2` |

## Prerequisites Before Recording

1. A Midnight **DApp Connector v4.x wallet** (Lace or 1AM) installed in the recording browser, unlocked, on **Preprod**, with **Preprod DUST** funding.
2. The live verify flow needs a connected wallet credential AND a one-time contact-profile verification (email OTP).
   - If the verification backend reports email OTP as unavailable, the app shows the **demo-mode** flow: enter any email, then use the demo code **`123456`** to verify.
3. Ready the terminal in the repo directory for the test-output shot (Step 5).

## Recording steps (UI portion)

1. **Open the dApp** — navigate to `https://priestate.vercel.app/` (Landing page shows "PRIVESTATE — Privacy-Preserving Digital Land & Property Registration").
2. **Connect wallet** — go to `/verify/reg-001` (or Sign In → Citizen User Sign-In → **Connect Wallet**). Approve the wallet connection in the DApp Connector wallet (Preprod). The sidebar on the verify page shows the connected **Network: preprod** and the truncated address.
   - First time: the route guard may send you to `/profile/verify` to complete contact verification. Enter an email, send the code, use demo code **`123456`** if demo mode is displayed, and verify.
3. **Perform the privacy / circuit operation** — on `/verify/reg-001` click **"Begin Verification"**. The page will show:
   - `Property Value ≥ Eligibility Threshold` (with **PRIVATE** value and **PUBLIC** threshold)
   - "Generating Proof…" then proof animation
   - The dApp calls the Compact circuit `checkEligibility()` which proves `propertyValue >= eligibilityThreshold` **without revealing the property value**; only the Boolean result is disclosed on the ledger.
4. **Show the result** — when verified, click **"View Verification Result"** → `/verification/reg-001`:
   - **"PROPERTY ELIGIBILITY VERIFIED"** + **"ZK PROOF VALID"** badge
   - **PROVED** status and **PUBLIC Boolean eligibility result only — never the property value**; Property Value shown as **PRIVATE**.

## Recording steps (evidence portion)

5. **Terminal test output** — from the repo root run `npm test` and capture the final tally:
   `1..436` · `# tests 436` · `# pass 436` · `# fail 0`.
6. **README with green CI badge** — open `README.md`; the badge is at the top (line 3):
   `[![CI](https://github.com/techwithjainparam/midnight-moonshot/actions/workflows/ci.yml/badge.svg)]` → renders **"CI — passing"**.

## One-line narration core

"PRIESTATE proves a property meets an eligibility threshold on Midnight Preprod with a zero-knowledge proof — the property value stays private; only the Boolean result is disclosed on-chain."

## Optional supporting captures (already in repo)

- `docs/evidence/level3-tests.png` — test-suite evidence screenshot.
- `screenshots/priestate-preprod-deployment-proof.png` — Preprod deployment proof (contract address visible).

## Reminders

- Do **not** fabricate any result. Run real flows; the app never fakes a pass/fail verdict.
- Keep the video ~1 minute. Order can be: UI flow → terminal tests → README badge.