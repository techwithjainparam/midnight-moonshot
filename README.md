# midnight-moonshot

Privacy-first dApp built on Midnight, evolving from a Compact smart contract to a production-ready Web3 application.

## PRIESTATE — Privacy-First Property Eligibility Proof

A technical privacy prototype (not a land registry, legal ownership system, or marketplace). PRIESTATE lets a user **privately prove that a property value meets a predefined eligibility threshold without revealing the actual property value**.

The private property value is used inside the Compact zero-knowledge circuit to check:

```text
propertyValue >= eligibilityThreshold
```

Only the eligibility result is disclosed publicly on the ledger. The property value stays private forever.

## Status — Level 2

| Stage | Status |
| ----- | ------ |
| Frontend foundation (Vite + React + TypeScript) | Done |
| Compact PRIESTATE contract | Done |
| Midnight SDK dependencies | Done |
| Contract compilation + managed artifacts | Done |
| Basic test setup | Done |
| Lace wallet UI | Not started (later level) |
| Circuit frontend integration | Not started (later level) |
| Preprod deployment | Not started (later level) |

## Smart Contract

`contracts/priestate.compact`:

```compact
pragma language_version >= 0.23;

import CompactStandardLibrary;

export sealed ledger eligibilityThreshold: Uint<64>;

export ledger eligibilityResult: Boolean;

witness propertyValue(): Uint<64>;

export circuit checkEligibility(): [] {
  const value = propertyValue();
  eligibilityResult = disclose(value >= eligibilityThreshold);
}

constructor(threshold: Uint<64>) {
  eligibilityThreshold = disclose(threshold);
}
```

* The eligibility **threshold** is a public, sealed ledger field set once at deployment.
* `propertyValue` is a **witness** — supplied privately by the DApp, never published.
* `checkEligibility` computes `propertyValue >= eligibilityThreshold` inside the circuit and **discloses only the Boolean result** to the `eligibilityResult` ledger field.

## Project Structure

```text
midnight-moonshot/
├── contracts/
│   ├── priestate.compact          # Compact smart contract source
│   └── managed/priestate/         # generated artifacts (gitignored)
├── server/                        # PRIESTATE verification API (email OTP + Aadhaar KYC)
├── src/                           # Vite + React frontend foundation
├── tests/
│   ├── compile.test.ts            # toolchain + compile + artifacts + contract-info
│   └── contract-api.test.ts       # generated contract API smoke tests
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Commands

```bash
npm install          # install dependencies
npm run compile      # compact compile contracts/priestate.compact contracts/managed/priestate
npm run test         # run the test suite (tsx --test)
npm run typecheck    # tsc --noEmit
npm run dev          # start the Vite dev server
npm run verify-server# start the verification API (email OTP / Aadhaar KYC)
npm run build        # typecheck + production build
npm run clean        # remove generated artifacts and build output
```

### Generated Artifacts

`compact compile` writes the following under `contracts/managed/priestate/`:

```text
├── compiler/contract-info.json   # interface metadata (circuits, witnesses, ledger)
├── contract/index.js             # generated contract API (+ index.d.ts, .js.map)
├── keys/checkEligibility.prover  # proving key
├── keys/checkEligibility.verifier
└── zkir/checkEligibility.zkir    # compiled circuit (+ .bzkir)
```

## Notes

* `contracts/managed/` is gitignored and regenerated with `npm run compile`.
* Lace wallet UI and circuit frontend integration are intentionally deferred to later levels.

## Access Control & Roles

PRIESTATE separates public, protected user, and officer functionality.

### Route visibility

| Route | Visibility |
| ----- | ---------- |
| `/` | **Public** — landing page, product information, Connect Wallet CTA |
| `/register`, `/register/review`, `/registry`, `/property/:id`, `/verify/:id`, `/verification/:id`, `/dashboard` | **Protected** — require a connected wallet |
| `/officer` | **Officer only** — requires connected wallet + demo officer authorization |

Behavior:

* When the wallet is disconnected (or its state is still unknown), protected
  routes render no application content. Direct navigation shows
  **“Connect your wallet to access PRIESTATE.”**
* While wallet state is loading (`detecting` / `connecting`) guards render
  nothing, so protected content never flashes before authorization is known.
* Disconnecting immediately removes access to all protected routes.
* The navbar hides Register / Registry / Dashboard when disconnected and never
  shows Officer navigation to normal users.

### Role model

```
wallet connected → determine role → USER | OFFICER
```

Implemented in `src/auth/roles.ts`; exposed app-wide by `AuthProvider`
(`src/auth/AuthContext.tsx`), which wraps the existing `useWallet` hook —
wallet logic exists in exactly one place and route guards reuse it.

* **USER** — sees only their own application/property information plus the
  explicitly public registry (finalized APPROVED records). Officer queues,
  internal notes, approve/reject controls, and other applicants' data are not
  rendered anywhere in the user experience.
* **OFFICER** — sees the Authorized Officer Portal (`/officer`) with pending
  applications, applicant/property review data, review timeline, internal
  notes, ZK status, and Approve/Reject controls.

### ⚠️ Demo-only officer authorization

There is **no production government authentication yet**. Officer
authorization is a clearly-labeled demo mechanism (`src/auth/roles.ts`):

1. Set `VITE_DEMO_OFFICER_ADDRESSES` (comma-separated wallet addresses) at
   build time; those addresses are treated as officers.
2. Or use the “Simulate Officer Sign-In (DEMO)” control on the unauthorized
   screen at `/officer`, which grants the role for the current browser session
   only.

This is client-side and trivially bypassable. It shapes the UI/UX correctly;
it does not secure anything. A real deployment must replace it with proper
authorized-officer credentials enforced by the responsible authority.

## Record model — append-only history

Finalized property records are modeled as an ordered log of events
(`src/data/record-history.ts`). Events are only ever **appended** — there is
no API to edit or delete them. A finalized registration stays in history, and
future changes must be recorded as new authorized events:

```
PROPERTY reg-004
├─ 2023-08-05  Registration SUBMITTED   (by USER)
├─ 2023-08-10  Registration APPROVED    (by OFFICER)  ← finalized
└─ <future>    e.g. Ownership Transfer REQUESTED/APPROVED
               (new authorized events; previous entries remain)
```

The property page renders this history as a timeline and marks finalized
records: they cannot be edited, deleted, or silently replaced. Officer
decisions in the portal append new events rather than rewriting state.

### ⚠️ Security limitations (read before relying on any of this)

* **Frontend code alone does NOT make records tamper-proof.** The append-only
  store is an in-browser demo of the data model and UI. Anyone with access to
  the client runtime can alter it.
* True immutability/tamper-resistance must be enforced by the appropriate
  backend / blockchain / cryptographic authorization layer (e.g. recording
  each event on Midnight as an authorized transaction). The PRIESTATE Compact
  contract was intentionally **not** modified to simulate this.
* Role checks, route guards, and demo ownership bindings
  (`DEMO_USER_PROPERTY_IDS`) are client-side UX controls, not security
  boundaries.
* All registry records are mock data.

## Contact & identity verification

The user flow is: **Connect Wallet → verify Email OR Aadhaar-linked mobile →
Verified Profile → Register / Dashboard** (officers bypass the contact gate).
Verification runs against a small server-side API (`server/`), never in the
browser:

* **Email** — the API generates a 6-digit OTP, stores only an HMAC of it, and
  delivers it to the user's inbox via authenticated SMTP. Codes expire, are
  single-use, allow limited attempts, have a resend cooldown, and both per-
  contact and per-IP rate limits. The code is never displayed in the browser,
  never stored in `localStorage`, and never returned by any endpoint.
* **Aadhaar-linked mobile** — performed by an **authorized identity/KYC
  provider** (e.g. Surepass / Karza / Signzy / IDfy / Protean). A plain SMS
  OTP proves possession only and is NOT used. The adapter supports direct
  mobile→Aadhaar link checks and vendor OTP challenges to the registered
  mobile; ambiguous vendor answers fail closed. Only the provider receipt
  (`providerVerificationId`, status, timestamp) is stored — no Aadhaar number.
* Without configured credentials the UI honestly shows
  “Verification service unavailable.” /
  “Aadhaar-linked mobile verification is currently unavailable.” — there is
  no demo fallback in the production flow. (A development mock remains only
  for automated tests.)

### Running it

```bash
cp .env.example .env      # fill in SMTP + KYC credentials (server-side only)
npm run verify-server     # verification API on :8787
npm run dev               # Vite proxies /api → :8787 in development
```

All secrets live in plain (non-`VITE_*`) environment variables read only by
the Node process. The only frontend-visible variable is
`VITE_VERIFICATION_API_URL` — a public URL, not a credential.
