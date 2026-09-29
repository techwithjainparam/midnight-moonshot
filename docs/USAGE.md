# PRIESTATE — Usage Guide

Step-by-step guide to running the PRIESTATE MVP: from an empty browser to a
zero-knowledge eligibility proof on Midnight Preprod.

- **Product overview, privacy model, tech stack** → [../README.md](../README.md)
- **Product proposal** → [../PROPOSAL.md](../PROPOSAL.md)

| | |
| --- | --- |
| Live app | https://priestate.vercel.app |
| Preprod contract | `fe251d3c8c26ccd56255a636c205c6b804489dbbaf41ddf316244ceb7f3159c2` |
| Verification API | https://backend-production-25553.up.railway.app |
| Network | Midnight **Preprod** (testnet — no real value at risk) |

> **You are on a test network.** Preprod tokens have no monetary value. Never
> use a wallet that holds real funds on another Midnight network.

---

## 1. What You Need

### To use the live demo

| Requirement | Notes |
| --- | --- |
| A modern browser | Chrome, Edge, Firefox or Safari. A phone works too — the layout is responsive. |
| A Midnight **DApp Connector v4.x** wallet | [Lace](https://lace.io) or 1AM. It must be switched to the **Preprod** network. |
| A camera + microphone | Only if you go through account registration, which includes a liveness stage. You can skip registration and go straight to the property flow if you already have a wallet. |
| ~2 minutes | Proof generation is the slow part; everything else is quick. |

### To run it locally

| Requirement | Notes |
| --- | --- |
| Node.js **22+** and npm | `node --version` must report 22 or newer. |
| The `compact` CLI toolchain | CLI `0.5.1` → `compact update 0.31.1`. **Not** an npm package. |
| Docker Desktop | Only for the local proof server used to generate proofs. |
| `.env` | Copied from `.env.example`. Never commit it. |

---

## 2. Quick Start (the fast path)

If you only want to see the privacy claim working:

1. Open **https://priestate.vercel.app**
2. Click **Connect Wallet** in the navbar and connect your Preprod wallet.
3. Open any property, or register a new one from **Register Property**.
4. Click **Verify** to run the zero-knowledge eligibility check.
5. Watch the proof generate, then read the result on the verification page.
6. Open the **contract** — only a `true`/`false` verdict was ever published.

That is the whole product. Sections 3–7 explain what happened and what stayed private.

---

## 3. Account Registration (optional)

Registration is **wallet-free** — you create the account first and bind a wallet
afterwards. The flow is server-authoritative: every gate is enforced on the
backend, and the UI cannot skip ahead.

| # | Step | What happens |
| --- | --- | --- |
| 1 | **Personal information** | Name, Aadhaar number, address, pincode (validated against India Post), date of birth, mobile. Stored **encrypted at rest**; only masked forms are ever returned to the browser. |
| 2 | **Aadhaar / KYC document** | Server-side OCR extracts the name and cross-checks it against what you typed. **The filename is never read.** |
| 3 | **Email verification** | A one-time code is emailed to you. It is generated server-side, stored only as an HMAC hash, expires, is single-use, and is **never returned by any API**. |
| 4 | **Aadhaar–mobile link** | Authorized KYC provider link check. Reported unavailable rather than faked if no provider is configured. |
| 5 | **Password** | Salted `scrypt` hash only. The plaintext is never stored or logged. |
| 6 | **Photo** | Server-side PNG validation with real per-pixel checks. |
| 7 | **Liveness** | 68-point face landmarks plus active challenges (blink, head movement, hand up, finger count, phrase). |
| 8 | **Location** | Browser geolocation, validated for freshness and accuracy. |
| 9 | **Finalize** | The session is frozen and the account becomes active. You then connect a Midnight wallet to bind it. |

> **Email delivery note.** The email step is live in code, but the current
> hosting provider blocks outbound SMTP on port 587, so a code may not actually
> arrive. This is a hosting/network limitation, not a privacy fallback — the
> step does **not** skip verification when mail fails. It fails closed.

---

## 4. Property Registration Workflow

Property registration is **wallet-gated** — the on-chain transaction is signed by
your wallet, so it cannot be done anonymously.

1. **Connect wallet** — the app joins the deployed Preprod contract at the fixed
   address. If you are on the wrong network, the app says so rather than
   silently failing.
2. **Register property** — enter owner name, property ID, survey number, address,
   village, taluka, district, and land area. Required fields are validated
   inline.
3. **Submit on-chain** — the registration is written to the contract with status
   `PENDING`. This is a real transaction against the real contract.
4. **Registry view** — open **Registry** to see the registration and its current
   status.

### The registration lifecycle

```text
   submitRegistration()
          │
          ▼
      PENDING ──────────────────────────────┐
          │                                  │
  approveRegistration()              rejectRegistration()
   (officer only)                      (officer only)
          │                                  │
          ▼                                  ▼
      APPROVED                          REJECTED
```

Authorization is cryptographic, not a UI toggle: the officer circuit re-derives
the caller's public key from `officerSecretKey` and asserts it matches the sealed
`officer` public key fixed at deployment.

---

## 5. Privacy-Preserving Verification

This is the core of the product.

The eligibility threshold is **sealed on-chain at deployment** and is public. The
property **value** is a **private witness**.

```text
   propertyValue  ──►  Compact circuit  ──►  eligibilityResult (true/false)
   (private)            checks ≥              (the ONLY thing published)
                        threshold
```

What the circuit does internally:

1. `VerifyPage` resolves the deployment and joins the contract.
2. `PriestateAPI.checkEligibility(propertyValue)` sets `_propertyValue` in the
   witness module. It is never written to public state.
3. `callTx.checkEligibility()` asks your wallet to generate the zero-knowledge proof.
4. The proof is submitted via `submitTx()`.
5. The app waits for on-chain confirmation, then reads the published
   `eligibilityResult` back from the ledger.

**The result shown in the UI is read from the ledger, not recomputed in the
browser.** There is no client-side shortcut to a "pass".

---

## 6. What Gets Proved vs. What Stays Private

### Public (on the Midnight ledger)

| Item | Why it is public |
| --- | --- |
| `eligibilityThreshold` | The rule is public so the proof is meaningful. Sealed once at deployment so it cannot be changed later. |
| `officer` (public key) | Reviewer authority must be verifiable by everyone. |
| `registrationCounter` | An append-only count of registrations. |
| `registrations` map | Owner binding, area, status, district, timestamps, reviewer. |
| `eligibilityResult` | The Boolean verdict. This is the entire point. |

### Private (never published)

| Item | Where it lives |
| --- | --- |
| `propertyValue` | Client memory only, as a witness. Never in public state. |
| `applicantSecretKey` | Client only. |
| `officerSecretKey` | Client only. |
| Name, Aadhaar, address, DOB, mobile | Encrypted at rest on the backend (`AES-256-GCM`); masked in every API response. |
| Password | Salted `scrypt` hash only. |
| Face images and embeddings | Server-side encrypted reference store; raw images are not persisted. |
| OTP codes | Stored only as an HMAC hash; never logged, never returned. |

### The one-line claim

> PRIESTATE publishes a `true`/`false` and nothing else. The number that decided
> it never leaves the device that typed it in.

---

## 7. Registry Review

The **officer** side is a separate, server-authorized surface.

1. Go to **Officer Login** and authenticate with the server-backed officer
   credential.
2. The review queue lists registrations in `PENDING` state.
3. Approving or rejecting writes an on-chain state change attributed to the
   officer's public key.
4. The registry and dashboard pages read the resulting status back from the
   contract.

The government/legal land registry remains **authoritative and off-chain**.
PRIESTATE records *that* a privacy-preserving claim holds and *who* authorized
it. It does not replace land records, and it does not confer legal title.

---

## 8. Result / Status

After verification you land on a result page. It has three honest outcomes:

| Outcome | Meaning |
| --- | --- |
| **Eligible** | The on-chain `eligibilityResult` is `true`. |
| **Not eligible** | The on-chain `eligibilityResult` is `false`. |
| **No on-chain verification this session** | No proof transaction finalized in this session. Nothing is inferred, cached, or guessed. |

The result is stored in `sessionStorage` for the current session only and is
never treated as a durable credential.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| **Connect wallet does nothing** | No DApp Connector v4.x wallet, or wrong network | Install Lace/1AM and switch it to **Preprod** |
| **"Wrong network" / join fails** | Wallet on Preview or mainnet | Switch the wallet to Preprod and reload |
| **Proof spins forever** | Local proof server not running | `npm run proof-server:start`; confirm Docker Desktop is running |
| **`compact: command not found`** | Compact toolchain not installed | Install CLI `0.5.1`, then `compact update 0.31.1` |
| **`npm run compile` fails on language version** | Toolchain/language mismatch | Use toolchain `0.31.1` (language `0.23.0`) to match `compact-runtime@0.16.0` |
| **Email code never arrives** | Hosting provider blocks outbound SMTP | Known limitation — see the note in section 3. The step does not fall back to a fake code. |
| **Liveness rejected** | Poor lighting, or a challenge timed out | Face the camera in even light and follow the on-screen instruction |
| **"Location could not be read"** | Permission denied, or fix too old/inaccurate | Allow location access; accuracy must be within the accepted range and the fix must be fresh |
| **"NO ON-CHAIN VERIFICATION THIS SESSION"** | Proof not finalized in this session | Re-run verification; the verdict is only ever read from the ledger |
| **Officer page rejects login** | Wrong/absent officer credential | Officer authorization is server-side; there is no client-side override |
| **Backend 401/403 from the browser** | CSP missing the backend origin | Add the backend origin to `connect-src` in `vercel.json` |
| **Local server ignores `.env`** | No dotenv loader | `set -a; source .env; set +a` before `npm run verify-server` |

---

## 10. Safety Notes

- **Never share** your wallet seed, private key, password, or OTP with anyone —
  including anyone claiming to be PRIESTATE support. The demo video and support
  requests must never show them.
- The liveness stage uses real landmark inference and blind challenges. It is
  **not** depth-based or replay-proof anti-spoofing, and should not be relied on
  as a sole high-assurance identity check.
- Aadhaar/KYC is **provider-ready architecture only** — no UIDAI-authorized
  provider is connected, so that step reports unavailable instead of faking a
  pass.
- Preprod is a test network. Nothing here has monetary value.
