# PRIVESTATE — Product Proposal

**Privacy-Preserving Property / Land Registration & Verification DApp**

A Midnight-based DApp that lets a property owner register a parcel on-chain and prove land-eligibility without revealing the underlying property value or personal identity data to the public ledger.

> This document describes only functionality and architecture that is **actually implemented** in the repository. Where a component is a boundary, a demo stand-in, or not yet production-integrated, it is labelled as such. No capabilities are exaggerated.

---

## 1. Product name

- **Product:** PRIVESTATE
- **Full title:** Privacy-Preserving Property / Land Registration & Verification DApp
- **One-liner:** Register property on the Midnight ledger and prove eligibility in zero knowledge — without exposing the property's value or the registrant's identity to the public.

---

## 2. Problem

Modern property and identity workflows require institutions and counterparties to handle large amounts of sensitive data, most of which is unrelated to the decision being made. In practice this creates two linked problems:

1. **Unnecessary exposure of sensitive personal information.** Land records and eligibility checks commonly force disclosure of legal names, addresses, contact details, government-issued identifiers, and financial figures. Projecting that data onto a shared or public record makes it visible to everyone who can read the record, not just to the department actually responsible for the decision.
2. **Confidentiality of the eligibility decision is broken.** Verifying "does this property meet the eligibility threshold?" should not require revealing the exact property value. Yet today the answer is almost always derived by handing the private value to a third party, or by writing the value itself into a shared registry.

The core problem PRIVESTATE addresses is: **prove a property satisfies an eligibility criterion without publishing the property value, and register ownership without broadcasting raw identity data.**

---

## 3. Solution

PRIVESTATE is a wallet-first DApp that combines an on-chain registration registry with privacy-preserving verification:

- **Wallet-based property registration** — the owner/applicant registers a parcel against a disclosed derived public key from their own wallet secret, binding the registration to a real key they control.
- **Authorized registry/officer review** — a designated officer public key is sealed into the ledger at deployment; only that authority can approve or reject a registration.
- **Midnight privacy-preserving verification** — eligibility is computed inside the circuit from a private witness and only the Boolean result is disclosed on-chain (`checkEligibility`).
- **ZK eligibility proof** — the circuit proves `propertyValue >= eligibilityThreshold` without ever publishing `propertyValue`.
- **Controlled registration lifecycle** — registrations move through `PENDING → APPROVED | REJECTED` with a reviewed-by/reviewed-at audit trail recorded on-chain.

The combination means the ledger stores **who registered what and whether it passed**, not the private value or the raw identity of the applicant.

---

## 4. User flow

The implemented, end-to-end product flow is:

1. **Wallet-free account registration.** The user registers a server-side account through an 11-step stepper (`/register-account`) — personal + Aadhaar → Aadhaar document OCR → email → SMS OTP → WhatsApp OTP → Aadhaar-mobile link → password → photo → liveness → location → finalize. **No Midnight wallet address is required or typed at registration.**
2. **Wallet association after registration.** After finalize, the citizen connects their real Midnight wallet to bind it to the account (`walletAddress`), then enrolls biometrics. Login/continuation uses the associated wallet.
3. **Property registration application.** The owner submits a registration; the client persists safe public metadata that references the real on-chain registration id returned by a successful on-chain `submitRegistration`.
4. **Registry/officer review.** The designated officer reviews submitted registrations in the review portal — gated by a server-backed officer credential (with a labelled demo fallback), not by a wallet.
5. **Approval / rejection.** The officer authorizes an on-chain `approveRegistration` or `rejectRegistration`, which appends to the registration lifecycle and moves the record to its finalized state.
6. **Verification / eligibility flow.** A caller runs the eligibility circuit against the deployed contract and receives a privacy-preserving Boolean result saved to `sessionStorage` and rendered on a result page.

---

## 5. Privacy architecture

PRIVESTATE separates surfaced data into three explicit tiers.

### PUBLIC — on-chain data
Only the following is public on the Midnight ledger:

- Public `Registration` record: owner binding (derived public key), public `area`, `district`, lifecycle `status`, submission/review timestamps, and reviewer binding.
- Deployment-sealed `eligibilityThreshold` and designated `officer`.
- Registration counter and the Boolean `eligibilityResult` of the eligibility circuit.

Raw names, full addresses, contact details, government-issued identifiers, passwords, face images, and facial embeddings are **not** on the ledger. The on-chain `Registration` record deliberately carries no free-form owner-name/village/survey fields; fields that cannot be sourced from on-chain state are surfaced as an explicit "unavailable" marker rather than invented (`src/registration-view.ts`).

### PRIVATE — server-side data
- Account passwords are stored only as salted **scrypt** digests (`N=2^14`, memory-hard) and are never recoverable.
- Retrievable PII (e.g. name, address) is encrypted at rest with **AES-256-GCM** under a server-only secret; the account record holds only the ciphertext plus masked display fragments (masked mobile, masked Aadhaar) — never raw values.
- Demo face images are processed in-memory and **never uploaded, persisted, or written to the ledger**.
- The mobile session carry-over URL carries no PII.

### "Proves without revealing"
- The eligibility circuit proves `propertyValue >= eligibilityThreshold` and discloses **only the Boolean result** via the `eligibilityResult` ledger value. The private `propertyValue` witness is never published.
- The registrant's proof of control is a **derived public key** from their secret key — the secret itself is a private witness.

**Stated explicitly: raw PII, Aadhaar data, biometric data, raw face images, and face embeddings are NOT stored on the public Midnight ledger.**

---

## 6. Midnight integration

Only the actually implemented Compact/ZK functionality is described here. Midnight is used as a verifiable computation + public-record layer, **not** as an off-the-shelf database.

- **Compact contract** (`contracts/priestate.compact`) declares the `Registration` struct, sealed `eligibilityThreshold` and `officer` ledgers, registration/dust ledgers, and the eligibility result ledger.
- **Eligibility check** — `checkEligibility` reads the private `propertyValue` witness, compares it against the sealed threshold inside the circuit, and publishes only the Boolean result.
- **Registration lifecycle** — `submitRegistration` records owner/area/district; `approveRegistration` / `rejectRegistration` re-derive the caller's public key from the officer secret witness and assert it equals the sealed `officer`, so only the designated officer can change lifecycle status.
- **Privacy-preserving verification** — the browser uses the wallet's built-in proving provider (no local proof server needed for verification); a standalone proof server exists only for CLI deployment scripts.

The repository compiles the contract via `npm run compile` and manages the resulting artifacts under `contracts/managed/priestate`.

---

## 7. Security architecture

- **Wallet binding** — registrations and lifecycle changes bind to keys derived from wallet secrets; an account is bound to a unique `walletAddress`.
- **Password hashing** — salted scrypt with memory-hard cost parameters; verification is constant-time (`timingSafeEqual`) and never reveals why a check failed.
- **OTP handling** — server issues and verifies SMS/WhatsApp OTP factors against the account record; enforcement is fail-closed (a factor only counts as satisfied when the server accepts it).
- **Secure server sessions** — sessions are server-backed, bound to account + wallet, with expiry; the server is the only session-minting path.
- **Server-authoritative authentication** — `AccountService.login()` is the sole login path, gated on password plus factors plus an `identity_verified` flag. It accepts only `{ walletAddress, password }`; no client-supplied biometric/face-match field can mint a session.
- **Fail-closed verification behavior** — when a face/reference provider is unavailable or no reference identity exists, the system reports `verification_unavailable` / `provider_unavailable` rather than inventing a match or score.
- **Privacy tests** — an explicit test suite (`tests/account-privacy.test.ts`) guards the invariants that no raw PII / password / selfie / biometric is persisted or serialized, and that the account layer produces no on-chain payload text.

**Note on provider dependencies:** actual OTP *delivery* and the Google factor sit at real external/provider boundaries. The factor state machines and server enforcement are implemented; live SMS / WhatsApp / Google credentials are not part of the shipped code.

---

## 8. Level 3 authentication (implemented)

Registration and login are each gated on a set of factors. All are server-validated; the components themselves are as follows:

| Factor | Status | Notes |
|--------|--------|-------|
| **Wallet** | REAL / COMPLETE | Wallet connection; account bound to an associated wallet address after wallet-free registration |
| **Password** | REAL / COMPLETE | Salted scrypt hash, constant-time verify |
| **SMS OTP / WhatsApp OTP** | PROVIDER-READY | Factor gating + server enforcement are real; actual SMS/WhatsApp delivery requires live gateway credentials |
| **Google factor** | PROVIDER-READY | Factor boundary is implemented; live Google OAuth credentials are not shipped |
| **Registration liveness** | REAL | Real 68-point face landmarks + blind blink/head/hand-up/finger-count/phrase challenges; not depth/replay-proof |
| **Login face verification** | REAL | Real face-api inference (68-point landmarks + 128-d FaceNet embeddings), encrypted server-side reference store, server-authoritative matched/mismatch verdict |
| **Live location** | REAL | Browser geolocation, client-side validation + server acceptance (fail-closed) |
| **Officer credential** | REAL | Server-backed single-officer credential (commissioning code, separate session cookie); wallet-demo fallback clearly labelled |

External/provider-dependent components are clearly labelled above. They are not claimed as production-integrated.

---

## 9. Face verification status (accurate)

- **Part 6 implements a REAL login face-verification stage.** Login runs a mandatory multi-factor authentication (Wallet → Google → SMS OTP → WhatsApp OTP → Password) and then a distinct, explicit identity stage:
  - **Liveness** answers *"is a real, live person in front of the camera?"* — real 68-point landmark inference (`@vladmandic/face-api`, served from `public/models/`) with blind blink/head challenges plus server-issued hand-up / finger-count / phrase challenges; fail-closed on model-load failure.
  - **Face matching** answers *"does the live face match the registered identity reference?"* — the server derives a 128-d FaceNet embedding from real face-api captures, encrypts it at rest under a separate `ACCOUNT_BIOMETRIC_ENC_SECRET` (AES-256-GCM, domain-separated), and returns only a `matched`/`mismatch` verdict computed server-side (`server/account/biometric.ts`, `server/account/service.ts`). Single-use, wallet- and reference-version-bound tokens; any client-supplied `matched`/`score` is ignored.
- Membership of `identityVerified=true` is set **only** by the server at successful biometric enrollment; the old bare-`confirmed:true` trust path was removed. `AccountService.login()` is the sole session-minting path.
- Camera frames stay in memory; no face, embedding, or biometric value reaches the ledger, URLs, query params, logs, localStorage, or any public/account response (the server exposes only booleans/verdicts).
- `src/verify/face-match.ts` remains a **demo-only** perceptual-similarity path and is **not** a production biometric reference — it is not used for the server-authoritative login verdict.
- **Not yet production-integrated:** official UIDAI/authorized Aadhaar (KYC) verification. **Not yet claimed:** depth/silent-liveness and replay/photo/video anti-spoofing beyond the landmark challenges above.
- **The system does not fabricate matches or scores.** No client-supplied `matched` / `score` assertion is accepted; the server remains the authority and returns no session/account when the face provider or reference is unavailable.

---

## 10. Property registry workflow

- **Registration submission** — owner submits on-chain; a server-side applicant-scoped endpoint persists only safe public metadata (reference id + optional name/village/etc.) tied to a real on-chain registration id. It never sends the confidential property value or a fabricated status/verdict.
- **Officer review** — a review portal presents submitted registrations to the designated officer.
- **Approval / rejection** — only the designated officer (whose public key is sealed in the ledger) can run `approveRegistration` / `rejectRegistration`; decisions append to the lifecycle history.
- **On-chain lifecycle** — `PENDING → APPROVED | REJECTED` is the source of truth on the ledger; the public registry shows only finalized (APPROVED) registrations.

> **Label:** Officer access to the review portal is **server-backed** (single
> officer account minted once per deployment behind `OFFICER_REGISTRATION_CODE`,
> separate `priestate_officer_sid` session cookie, salted-scrypt passwords;
> checked first by `RequireOfficer`). A **clearly-labelled demo fallback**
> remains: `src/auth/roles.ts` treats configured `VITE_DEMO_OFFICER_ADDRESSES`
> as officers, or offers a client-side "Simulate Officer Sign-In (DEMO)". This
> is an application credential, not government authentication — a real
> deployment must integrate the responsible authority's identity system. The
> on-chain approve/reject verdict is always enforced by the Compact circuit.

---

## 11. Technology stack

Derived from `package.json` and the repository layout:

- **Frontend:** React 19, Vite 8, React Router, TypeScript
- **Midnight:** `@midnight-ntwrk/compact-runtime`, DApp Connector API v4.x, `midnight-js-*` SDK modules incl. fetch ZK config, indexer public-data, level private-state, and node ZK config providers
- **Backend:** Node.js server (`server/index.ts`), `nodemailer`, WebSocket (`ws`) for the verification API
- **Storage:** SQLite (`better-sqlite3`) for server-side accounts/sessions
- **Cryptography:** Node `crypto` — scrypt (password), AES-256-GCM (PII at rest), constant-time comparison, BIP-39 / `@scure/bip39` and `@scure/base` for wallet seeds and encodings

---

## 12. Current implementation status

| Feature | Status | Notes |
|---------|--------|-------|
| Wallet connection (DApp Connector v4.x) | REAL / COMPLETE | Joins deployed Preprod contract by fixed address |
| Compact contract + compile + managed artifacts | REAL / COMPLETE | `npm run compile`; artifacts under `contracts/managed` |
| On-chain eligibility (ZK) check | REAL / COMPLETE | Owned/value privacy proofs; Boolean result only |
| On-chain registration lifecycle + registry views | REAL / COMPLETE | `submit` / `approve` / `reject`; public finalized-only view |
| Deployment script (Preprod) + contract address resolution | REAL / COMPLETE | `.midnight-state.json` + screenshot proof |
| Server-side accounts, sessions, scrypt passwords | REAL / COMPLETE | SQLite, AES-256-GCM PII at rest |
| Registration / login factor gating | REAL / COMPLETE | Server-authoritative; session minting gated |
| Privacy invariants | REAL / COMPLETE | `tests/account-privacy.test.ts` |
| Registration liveness | REAL | Real 68-point face-landmark challenges + server-issued hand-up / finger-count / phrase; not depth/replay-proof |
| Login face verification | REAL | Real face-api inference + encrypted server-side reference store + server-authoritative verdict |
| SMS / WhatsApp / Google factor delivery | PROVIDER-READY | Gating real; live credentials not shipped |
| Officer authorization | REAL (server-backed) | `server/account/officer.ts` single-officer credential; wallet-demo fallback clearly labelled |
| `src/verify/face-match.ts` | DEMO | Not used for the server-authoritative login verdict |
| Aadhaar verification | NOT AVAILABLE | Reports unavailable in demo; not production-integrated |

---

## 13. Roadmap

Genuine, not-yet-implemented future work (none of these are claimed as done):

- **Production identity / Aadhaar provider** — integrate an authorized KYC/eKYC gateway.
- **Audited/commercial face provider + anti-spoofing** — the current biometric provider (`@vladmandic/face-api`) is real but not production-audited; depth/silent-liveness and replay/photo/video resistance are not claimed.
- **Government/authority officer identity** — the server-backed officer credential is an application credential; integrating the responsible authority's identity system remains future work.
- **Live OAuth / SMS / WhatsApp credentials** — enable real delivery for Google, SMS, and WhatsApp factors.
- **Backend production deployment** — deploy the account/verification server so Level 3 server flows are reachable live.
- **Stronger production operational controls** — real rate limiting, audit logging, key management, and secret rotation.

---

## 14. Level 3 value proposition

PRIVESTATE demonstrates meaningful privacy-preserving blockchain usage rather than using the ledger as a database:

- The **eligibility decision** is computed in-silico and only the **Boolean result** is published — the private property value never reaches the ledger.
- **Ownership and lifecycle** are bound to derived public keys, so control is provable without exposing secrets or raw identity.
- **Identity and biometric material is explicitly kept off-chain** and server-side (encrypted at rest), with the demo provider boundary **fail-closed** rather than fabricating matches.
- A **designated officer** authorizes lifecycle changes on-chain, showing a controlled authority model rather than an open write path.

In short: the ledger records *whether* a low-knowledge claim holds and *who* authorized it — not the sensitive inputs behind either.

---

## 15. Demo / submission readiness (current evidence only)

What currently exists:

- **Deployed frontend** — live at https://priestate.vercel.app (Vercel; reachable).
- **Midnight Preprod deployment** — contract address `fe251d3c8c26ccd56255a636c205c6b804489dbbaf41ddf316244ceb7f3159c2` recorded in `.midnight-state.json` with a deployment-proof screenshot.
- **Automated tests** — currently **436/436 tests passing** covering account, auth, privacy, liveness, face-verification, registration, registry, and officer paths (verified via `npm test`).
- **CI pipeline** — `.github/workflows/ci.yml` runs compact compile, copy-circuits, typecheck, tests, and a production build on push/PR; README shows a CI badge.
- **Demo video (Level 2)** — https://youtu.be/UQwleyyFHqQ.

Known current limitations (accurate, not hidden):

- Face verification is **REAL for the current build** — real face-api (68-point landmarks + 128-d FaceNet embeddings), an encrypted server-side biometric reference store, and server-authoritative matched/mismatch login face matching (no client-asserted matches, no fabricated verdicts).
- Aadhaar verification is **not production-integrated** (PROVIDER-READY; no UIDAI-authorized AUA connected).
- Officer authorization is **server-backed** (real, primary) with a **clearly-labelled wallet-demo fallback**; it is an application credential, not government authentication.
- The Level 3 backend server is **deployed on Railway** at https://backend-production-25553.up.railway.app and health-verified (HTTP 200); the live Vercel frontend at https://priestate.vercel.app is connected to it via `VITE_VERIFICATION_API_URL`. Server-side Level 3 flows therefore run against the live hosted instance, not only automated tests.
- Google / SMS / WhatsApp live delivery credentials are not shipped.

---

_Scope note: This proposal intentionally omits any invented users, revenue, market, or adoption metrics. Every capability described maps to an existing module, test, or documented boundary in the repository._