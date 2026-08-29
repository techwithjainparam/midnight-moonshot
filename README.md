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
| Test suite (88 tests) | Done |
| Wallet connection (DApp Connector v4.x) | Done |
| Circuit frontend integration (ZK proof flow) | Done |
| Contact verification (Email OTP + Aadhaar KYC) | Done |
| Preprod deployment script | Done |
| Browser ZK config (FetchZkConfigProvider) | Done |
| On-chain result capture & display | Done |
| Production build | Done |

## Deployment

The **PRIESTATE Compact contract** is deployed on the **Midnight Preprod** network:

* **Network:** Midnight Preprod
* **Deployed Contract Address:** `e5bddf519efe1ed61bf59c344e49c37340860fb99a60543056e97456224b5256`

This is the deployed **PRIESTATE Compact** smart contract. The frontend joins this exact address on the Preprod network, and the property eligibility flow runs against this on-chain contract.

## Privacy Model

PRIESTATE is built around a clear separation of what is public and what stays private.

### PUBLIC

The following is disclosed publicly on the Midnight ledger:

* The sealed **eligibility threshold** (`eligibilityThreshold`).
* The **designated officer** public key (`officer`).
* The **registration counter** and the **registry map** (`owner` binding, `area`, `status`, `district`, timestamps, reviewer).
* The Boolean **eligibility result** (`eligibilityResult`) — the final pass/fail verdict.

### PRIVATE

The **property value** (`propertyValue`) and the relevant private secrets — the applicant secret key and the officer secret key — remain private. They are used only inside the zero-knowledge circuit and are never written to the ledger.

### PROVES WITHOUT REVEALING

A user **proves** `propertyValue >= eligibilityThreshold` **without revealing the actual property value**. Only the eligibility result (true/false) becomes public on the ledger; the underlying property value stays private forever.

## Demo Video

A short walkthrough video demonstrating the PRIESTATE eligibility flow on Midnight Preprod will be added here.

_Demo video link (placeholder — to be added)._

## Smart Contract

`contracts/priestate.compact`:

```compact
pragma language_version >= 0.23;

import CompactStandardLibrary;

export enum RegistrationStatus { PENDING, APPROVED, REJECTED }

export struct Registration {
  owner: Bytes<32>,          // owner/applicant binding (DApp public key)
  area: Uint<64>,            // public property area
  status: RegistrationStatus,
  district: Bytes<32>,       // registry metadata
  submittedAt: Uint<64>,     // registry metadata
  reviewedBy: Bytes<32>,     // officer DApp public key
  reviewedAt: Uint<64>,      // review timestamp
}

export sealed ledger eligibilityThreshold: Uint<64>;
export sealed ledger officer: Bytes<32>;             // designated officer DApp public key

export ledger registrationCounter: Counter;
export ledger registrations: Map<Uint<64>, Registration>;
export ledger eligibilityResult: Boolean;

witness propertyValue(): Uint<64>;           // private: property VALUE
witness applicantSecretKey(): Bytes<32>;     // private: derives owner binding
witness officerSecretKey(): Bytes<32>;       // private: authorizes review

export circuit submitRegistration(...);
export circuit approveRegistration(...);      // designated officer only
export circuit rejectRegistration(...);       // designated officer only
export circuit checkEligibility(): [];        // existing eligibility circuit
```

* **Public ledger metadata**: eligibility threshold, designated officer, registration counter, the registry map (owner binding, area, status, district, timestamps, reviewer), and the Boolean eligibility result.
* **Private witnesses**: the property **VALUE** (`propertyValue`), plus the applicant and officer secret keys — never published. Only derived DApp public keys are disclosed where a binding or authorization must be recorded.
* **eligibility threshold** and the **designated officer** are sealed once at deployment (`constructor(threshold, designatedOfficer)`).
* `checkEligibility` computes `propertyValue >= eligibilityThreshold` inside the circuit and discloses only the Boolean result to `eligibilityResult`.
* Officer authorization: `approveRegistration`/`rejectRegistration` re-derive the caller's DApp public key from `officerSecretKey` and `assert` it equals the sealed `officer` public key.

## Project Structure

```text
midnight-moonshot/
├── contracts/
│   ├── priestate.compact          # Compact smart contract source
│   └── managed/priestate/         # generated artifacts (gitignored)
│       ├── contract/              # generated contract API
│       ├── keys/                  # proving/verifying keys
│       └── zkir/                  # compiled circuit (zkir + bzkir)
├── server/                        # PRIESTATE verification API (email OTP + Aadhaar KYC)
├── src/
│   ├── auth/                      # auth context + role model
│   ├── components/                # React components (guards, navbar, etc.)
│   ├── contract/                  # CompiledPriestateContract + witnesses
│   ├── data/                      # mock properties + on-chain result storage
│   ├── documents/                 # document upload + extraction
│   ├── pages/                     # page components (Landing, Verify, Result, etc.)
│   ├── profile/                   # contact verification providers
│   ├── dapp-wallet.ts             # DApp Connector wallet integration
│   ├── priestate-api.ts           # PriestateAPI (deploy/join + lifecycle)
│   ├── browser-manager.ts         # BrowserPriestateManager
│   ├── contract-address.ts        # contract address resolution
│   └── in-memory-private-state-provider.ts
├── tests/                         # 88 tests (compile, wiring, result, privacy, etc.)
├── public/
│   ├── keys/                      # ZK artifacts (copied by copy-circuits)
│   └── zkir/
├── scripts/
│   └── copy-circuit-files.ts      # copies ZK artifacts to public/
├── .midnight-state.json           # wallet seed + deployment records (gitignored)
├── .midnight-wallet-state/        # wallet sync cache (gitignored)
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── docker-compose.yml             # proof server container
```

## Commands

```bash
npm install          # install dependencies
npm run compile      # compact compile contracts/priestate.compact contracts/managed/priestate
npm run copy-circuits# copy ZK artifacts to public/ for browser fetch
npm run test         # run the test suite (tsx --test)
npm run typecheck    # tsc --noEmit
npm run dev          # start the Vite dev server (port 3000)
npm run verify-server# start the verification API (email OTP / Aadhaar KYC)
npm run build        # typecheck + production build
npm run preview      # serve production build locally
npm run deploy       # deploy contract to network (requires wallet sync + proof server)
npm run network      # show/set active network
npm run check-balance# check wallet balance
npm run proof-server:start  # start proof server (Docker)
npm run proof-server:stop   # stop proof server
npm run clean        # remove generated artifacts and build output
```

### Generated Artifacts

`compact compile` writes the following under `contracts/managed/priestate/`:

```text
├── compiler/contract-info.json   # interface metadata (circuits, witnesses, ledger)
├── contract/index.js             # generated contract API (+ index.d.ts, .js.map)
├── keys/<circuit>.prover         # proving key (per exported circuit)
├── keys/<circuit>.verifier
└── zkir/<circuit>.zkir           # compiled circuit (+ .bzkir)
```

## Notes

* `contracts/managed/` is gitignored and regenerated with `npm run compile`.

## Wallet Connection

PRIESTATE connects to any Midnight DApp Connector v4.x wallet (Lace, 1AM, etc.):

* Browser: `src/dapp-wallet.ts` initializes providers via `connectedAPI.getProvingProvider()`
* CLI deploy: `src/wallet.ts` uses `wallet-sdk` directly with `WalletFacade`
* Wallet seed/mnemonic stored in `.midnight-state.json` (gitignored)
* Wallet sync state cached in `.midnight-wallet-state/` (gitignored)

## Zero-Knowledge Proof Flow

The verification flow proves `propertyValue >= eligibilityThreshold` without revealing the property value:

1. User connects wallet and navigates to `/verify/:id`
2. `VerifyPage` calls `manager.resolve()` → joins the deployed contract
3. `PriestateAPI.checkEligibility(propertyValue)`:
   - Sets `_propertyValue` in the witness module (never exposed to ledger)
   - Calls `callTx.checkEligibility()` → wallet generates ZK proof
   - Submits proof transaction via `submitTx()`
   - Waits for on-chain confirmation via `firstResultAfterTx()`
4. Post-transaction indexer emits the new `eligibilityResult` (Boolean)
5. Result saved to `sessionStorage` → displayed on `/verification/:id`

Privacy guarantee: only `eligibilityResult` (true/false) is disclosed on-chain. The property value stays private.

## Preprod Network

The project targets Midnight Preprod by default (`VITE_NETWORK_ID=preprod`):

* RPC: `https://rpc.preprod.midnight.network`
* Indexer: `https://indexer.preprod.midnight.network/api/v4/graphql`
* WebSocket: `wss://indexer.preprod.midnight.network/api/v4/graphql/ws`
* Faucet: `https://midnight-tmnight-preprod.nethermind.dev`

### Deployment

```bash
# 1. Start proof server (required for ZK proof generation)
npm run proof-server:start

# 2. Deploy contract (requires wallet sync + funded wallet + PRIVATE_STATE_PASSWORD)
PRIVATE_STATE_PASSWORD="<>=16 chars>" npm run deploy -- --network preprod

# 3. Restart dev server to pick up the deployed address
npm run dev
```

The deployment script:
* Restores wallet from `.midnight-wallet-state/preprod/`
* Waits for wallet sync (resumes from checkpoint)
* Funds wallet from faucet if needed
* Registers UTXOs for DUST generation
* Deploys contract via `deployContract()`
* Saves contract address to `.midnight-state.json`

### Contract Address Lifecycle

```
npm run deploy
  → writes address to .midnight-state.json.deployments.preprod
    → vite.config.ts reads .midnight-state.json at build/dev start
      → injects __PRIESTATE_DEPLOYED__ = { network: "preprod", address: "..." }
        → src/contract-address.ts resolves the address
          → BrowserPriestateManager.resolve() joins the deployed contract
```

No manual hardcoding required. The address flows automatically from deployment to runtime.

## Proof Server

A local proof server is required for ZK proof generation during deployment:

```bash
npm run proof-server:start   # starts midnightntwrk/proof-server:8.1.0 on port 6300
npm run proof-server:stop    # stops the container
```

The browser uses the wallet's built-in proving provider (no local proof server needed for verification). The proof server is only required for CLI deployment scripts.

## Environment Variables

All secrets use plain (non-`VITE_*`) env vars — never bundled into client JS:

```bash
# .env (gitignored)
VITE_NETWORK_ID=preprod
PRIVATE_STATE_PASSWORD="<>=16 chars"    # encrypts local private-state DB
OTP_HASH_SECRET="<hex>"                # HMAC for OTP hashing
SMTP_HOST=smtp.gmail.com               # email OTP delivery
SMTP_USER=...                          # SMTP credentials
SMTP_PASS=...
```

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
2. Or use the "Simulate Officer Sign-In (DEMO)" control on the unauthorized
   screen at `/officer`, which grants the role for the current browser session
   only.

This is client-side and trivially bypassable. It shapes the UI/UX correctly;
it does not secure anything. A real deployment must replace it with proper
authorized-officer credentials enforced by the responsible authority.

## Demo Mode

When the verification server is unreachable, the client enters demo mode:

* **Email OTP**: accepts the fixed demo code `123456` (no email sent)
* **Aadhaar**: shows "Aadhaar-linked mobile verification is not available in this demo"
* **Demo banner**: "Demo Mode — No email was sent. Use verification code **123456**"

Demo mode is clearly labeled in the UI. No real Aadhaar data is collected or transmitted.

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
