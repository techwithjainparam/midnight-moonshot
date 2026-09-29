# PRIESTATE — Level 4 Demo Script & Recording Checklist

Recording guide for the **Midnight Builder Challenge — Level 4** demo video
(~2 minutes). Every step below was verified against the deployed app, the
Preprod contract, the CI runs, and the repository state.

> **⚠️ Security rule for this recording.** Never show, type into frame, or read
> aloud: a wallet seed or mnemonic, a private key, a password, an OTP code, an
> API key, or any token. Blur or crop the wallet seed screen. The demo OTP code
> `123456` referenced in the Level 3 script **no longer exists** — that bypass
> was removed in commit `b198589` and must not appear in this video.

## Entry Points

| Item | Exact value |
| ---- | ----------- |
| Live frontend | `https://priestate.vercel.app` |
| Landing page (start here) | `/` |
| Property registration | `/register` |
| Registry | `/registry` |
| Privacy / circuit operation route | `/verify/reg-001` |
| Result screen route | `/verification/reg-001` |
| Dashboard | `/dashboard` |
| Network | Midnight **Preprod** |
| Deployed contract address | `fe251d3c8c26ccd56255a636c205c6b804489dbbaf41ddf316244ceb7f3159c2` |
| Verification API | `https://backend-production-25553.up.railway.app` |
| Repository | `https://github.com/techwithjainparam/midnight-moonshot` |
| Product X profile | `https://x.com/JPComputersPune` |

## Prerequisites Before Recording

1. A Midnight **DApp Connector v4.x** wallet (Lace or 1AM) installed in the
   recording browser, unlocked, switched to **Preprod**, with Preprod DUST.
2. The proof server is only needed for **local** runs. The live Vercel demo does
   not need Docker.
3. Terminal open at the repo root, ready for the CI/test shots.
4. Pre-recorded fallback: if live proof generation is slow, capture the
   `Generating Proof…` state and cut — never fake the result screen.

---

## Recording Steps

### 1 — Open the live MVP

`https://priestate.vercel.app/`

Landing page: **PRIVESTATE — Private. Verifiable. On-Chain.**

### 2 — Connect wallet

Navbar → **Connect Wallet** → approve in the DApp Connector wallet (Preprod).

Show the sidebar: **Network: preprod** and the truncated wallet address.

*If the route guard sends you to a sign-in step, complete it — but never film
the password or any code entry.*

### 3 — Property workflow

Go to **Register Property** (`/register`). Fill the property form — owner name,
property ID, survey number, address, village, taluka, district, land area — and
show the inline validation on a required field.

Submit on-chain. Show the registration appearing with status **PENDING** in
**Registry** (`/registry`).

> Narration: *"Registration is wallet-gated because the transaction is signed by
> the wallet. It is a real transaction against the real contract."*

### 4 — Privacy-preserving verification

Open `/verify/reg-001` and click **Begin Verification**.

Show on screen:

- `Property Value ≥ Eligibility Threshold`
- the property value labelled **PRIVATE**
- the eligibility threshold labelled **PUBLIC**
- `Generating Proof…` and the proof animation

> Narration: *"The value goes in as a private witness to a Compact circuit. The
> circuit checks value ≥ threshold and publishes only a boolean. The number is
> never written to the ledger — it can't be, it isn't part of the public
> state."*

### 5 — Verification result

**View Verification Result** → `/verification/reg-001`:

- **PROPERTY ELIGIBILITY VERIFIED** / **ZK PROOF VALID**
- **PUBLIC — Boolean eligibility result only, never the property value**
- Property Value still shown as **PRIVATE**

Also show the honest failure state is real (the app has a
"NO ON-CHAIN VERIFICATION THIS SESSION" state and never fabricates a pass).

### 6 — Preprod contract information

Show the contract address on screen:

```text
fe251d3c8c26ccd56255a636c205c6b804489dbbaf41ddf316244ceb7f3159c2
```

Then (optional, strong evidence) run the independent verification from the
README — it proves the contract is live without any PRIESTATE account:

```bash
ADDR=fe251d3c8c26ccd56255a636c205c6b804489dbbaf41ddf316244ceb7f3159c2
curl -s -X POST https://indexer.preprod.midnight.network/api/v4/graphql \
  -H 'Content-Type: application/json' \
  -d "{\"query\":\"query(\$address: HexEncoded!){ contractAction(address: \$address){ state } }\",\"variables\":{\"address\":\"$ADDR\"}}"
```

A live contract returns a `contract-state[v6]` payload.

### 7 — README

Open `README.md` in the browser (GitHub). Show:

- the **Live Demo** and **Preprod Contract** summary table
- the **Privacy Model** section — PUBLIC / PRIVATE / PROVES WITHOUT REVEALING
- the **Usage Guide** link to `docs/USAGE.md`

### 8 — Passing CI

Show the CI badge rendering **"CI — passing"**, then open the Actions tab and
show green runs on `main`.

Optionally run locally for the tally:

```bash
npm test        # # tests 472 / # pass 472 / # fail 0
npm run typecheck
npm run build
```

### 9 — Product X profile

Open the official PRIESTATE product profile:

**https://x.com/JPComputersPune**

Show the profile page: the bio, the link back to `https://priestate.vercel.app`,
and the pinned Preprod contract address.

> Narration: *"PRIESTATE lives on Midnight Preprod. The contract, the proof, the
> registry — all verifiable right now. The profile is at x.com/JPComputersPune."*

---

## One-Line Narration Core

> "PRIESTATE proves a property meets an eligibility threshold on Midnight Preprod
> with a zero-knowledge proof — the property value stays private; only the
> Boolean result is ever disclosed on-chain."

## Suggested Runtime

| Section | Target |
| ------- | ------ |
| 1–2 Open + connect | 20 s |
| 3 Property workflow | 25 s |
| 4–5 Verification + result | 30 s |
| 6 Contract + curl proof | 20 s |
| 7–8 README + CI | 20 s |
| 9 X profile | 15 s |
| **Total** | **~2 min** |

## Reminders

- Do **not** fabricate any result. Run real flows; the app never fakes a
  pass/fail verdict.
- Do **not** show seeds, private keys, passwords, OTPs, API keys, or tokens.
- Do **not** claim Google sign-in, Aadhaar/UIDAI KYC, or SMS login as live
  functionality — those are provider-ready only.
- Do **not** claim SMS or WhatsApp verification as part of registration; it was
  removed. Email verification is the registration gate.

## Supporting Captures

- `screenshots/priestate-preprod-deployment-proof.png` — Preprod deployment proof.
- `docs/evidence/` — archived evidence captures.
