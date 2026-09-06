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

1. **Owner/Builder connects wallet.** The DApp connects to the Midnight wallet (DApp Connector v4.x) and joins the deployed Preprod contract via the fixed contract address.
2. **Account registration and authentication.** The user registers a server-side account bound to their wallet address, then authenticates across the implemented factors (see sections 8 and 9).
3. **Property registration application.** The owner submits a registration; the client persists safe public metadata that references the real on-chain registration id returned by a successful on-chain `submitRegistration`.
4. **Registry/officer review.** The designated officer reviews submitted registrations in the review portal.
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
| **Wallet** | REAL / COMPLETE | Wallet connection + account bound to a unique wallet address |
| **Password** | REAL / COMPLETE | Salted scrypt hash, constant-time verify |
| **SMS OTP / WhatsApp OTP** | PROVIDER-READY | Factor gating + server enforcement are real; actual SMS/WhatsApp delivery requires live gateway credentials |
| **Google factor** | PROVIDER-READY | Factor boundary is implemented; live Google OAuth credentials are not shipped |
| **Registration liveness** | FOUNDATION | Motion-only liveness flow; distinct from face matching |
| **Login face verification** | PROVIDER-READY / NOT AVAILABLE | Provider boundary + fail-closed architecture (Part 6); no real CV bundled |

External/provider-dependent components are clearly labelled above. They are not claimed as production-integrated.

---

## 9. Face verification status (accurate)

- **Part 6 implements the provider boundary and fail-closed architecture.** The login face-verification stage runs through a state machine and a face provider boundary; when the provider is unavailable, it reports `provider_unavailable` honestly and never mints a session.
- **No real CV/face library is currently bundled.** The implementation deliberately does not depend on an unaudited facial-recognition dependency.
- **No legitimate registered biometric reference currently exists.** There is no enrolled, consented reference identity used for matching.
- **The demo `src/verify/face-match.ts` is NOT a production biometric reference.** It is explicitly demo-only — a crude client-side perceptual similarity score whose UI must be labelled "Demo Identity Verification". It is not an authorized Aadhaar/UIDAI matcher.
- **The system does not fabricate matches or scores.** No client-supplied `matched` / `score` assertion is accepted; the server remains the authority and returns no session/account when the face provider is unavailable.
- **Aadhaar verification is not currently production-integrated.** The shipped path reports "Aadhaar-linked mobile verification is not available in this demo" when the verification server is unreachable.

---

## 10. Property registry workflow

- **Registration submission** — owner submits on-chain; a server-side applicant-scoped endpoint persists only safe public metadata (reference id + optional name/village/etc.) tied to a real on-chain registration id. It never sends the confidential property value or a fabricated status/verdict.
- **Officer review** — a review portal presents submitted registrations to the designated officer.
- **Approval / rejection** — only the designated officer (whose public key is sealed in the ledger) can run `approveRegistration` / `rejectRegistration`; decisions append to the lifecycle history.
- **On-chain lifecycle** — `PENDING → APPROVED | REJECTED` is the source of truth on the ledger; the public registry shows only finalized (APPROVED) registrations.

> **Label:** The current officer authorization is **demo-only**. `src/auth/roles.ts` treats configured `VITE_DEMO_OFFICER_ADDRESSES` as officers, or offers a client-side "Simulate Officer Sign-In (DEMO)". The README states this is client-side and trivially bypassable, shaping UI/UX only — a real deployment must replace it with authorized-officer credentials enforced by the responsible authority.

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
| Registration liveness (motion) | FOUNDATION | Liveness flow only; not CV identity matching |
| Login face verification | PROVIDER-READY / NOT AVAILABLE | Boundary + fail-closed; no CV/reference bundled |
| SMS / WhatsApp / Google factor delivery | PROVIDER-READY | Gating real; live credentials not shipped |
| Officer authorization | DEMO | `src/auth/roles.ts`; client-side, README-labelled |
| `src/verify/face-match.ts` | DEMO | Not a production biometric reference |
| Aadhaar verification | NOT AVAILABLE | Reports unavailable in demo; not production-integrated |

---

## 13. Roadmap

Genuine, not-yet-implemented future work (none of these are claimed as done):

- **Production identity / Aadhaar provider** — integrate an authorized KYC/eKYC gateway.
- **Real CV / biometric provider** — adopt an audited facial-verification provider.
- **Secure biometric reference enrollment** — a consented, protected enrollment flow with a legitimate stored reference.
- **Production officer authorization** — replace demo role with authority-enforced credentials.
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
- **Midnight Preprod deployment** — contract address `e5bddf519efe1ed61bf59c344e49c37340860fb99a60543056e97456224b5256` recorded in `.midnight-state.json` with a deployment-proof screenshot.
- **Automated tests** — currently **407 tests passing** covering account, auth, privacy, liveness, face-verification, registration, registry, and officer paths (verified via `npm test`).
- **CI pipeline** — `.github/workflows/ci.yml` runs compact compile, copy-circuits, typecheck, tests, and a production build on push/PR; README shows a CI badge.
- **Demo video (Level 2)** — https://youtu.be/UQwleyyFHqQ.

Known current limitations (accurate, not hidden):

- Face verification is **provider-ready / not available** — no real CV, no legitimate biometric reference, no fabricated matches.
- Aadhaar verification is **not production-integrated**.
- Officer authorization is **demo-only**.
- The Level 3 backend server is **deployed on Railway** at https://backend-production-25553.up.railway.app and health-verified (HTTP 200); the live Vercel frontend at https://priestate.vercel.app is connected to it via `VITE_VERIFICATION_API_URL`. Server-side Level 3 flows therefore run against the live hosted instance, not only automated tests.
- Google / SMS / WhatsApp live delivery credentials are not shipped.

---

_Scope note: This proposal intentionally omits any invented users, revenue, market, or adoption metrics. Every capability described maps to an existing module, test, or documented boundary in the repository._