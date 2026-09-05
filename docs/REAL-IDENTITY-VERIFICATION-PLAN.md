# PRIVESTATE — Real Identity Verification GAP Audit & Implementation Plan

**Scope:** Audit the current Level 3 authentication/identity implementation and define exactly what is required to move it from demo/provider-ready to genuinely functional (production-capable) — without claiming anything real that is not.

**Ground truth applied throughout:** A feature is REAL only if the underlying functionality actually performs the claimed operation. A UI/state machine alone is NOT evidence of real functionality.

**Non-negotiables (preserved throughout):** Never write raw biometrics, face images, embeddings, Aadhaar data, passwords, or OTPs to the public Midnight ledger, `localStorage`, URLs, query strings, logs, frontend source, or public blockchain state. Never install random libraries merely to make tests pass. Never fabricate a match. Never claim official Aadhaar verification without an authorized integration.

---

## A. ALREADY REAL / FUNCTIONAL

These genuinely perform their claimed operation; none is a mock.

1. **Wallet connection & key binding (REAL).** DApp Connector v4.x joins the deployed Preprod contract by fixed address (`src/contract-address.ts`, `src/wallet.*`). Registrations and lifecycle changes bind to keys derived from wallet secrets.
2. **Server-side account persistence (REAL).** SQLite (`better-sqlite3`) via `server/account/db.ts`, `sqlite-store.ts`. Persistent by default in `server/index.ts` (`openDatabase` → `SqliteAccountStore`). Holds only: scrypt password hash + salt, AES-256-GCM PII ciphertext, masked display fragments, factor flags.
3. **Password hashing (REAL).** `server/account/security.ts` — salted scrypt (`N=2^14`, r=8, p=1), constant-time `timingSafeEqual` verify, never recoverable.
4. **PII at-rest encryption (REAL).** AES-256-GCM via `encryptPII`/`decryptPII` with a key derived from the server-only `ACCOUNT_ENC_SECRET`; fails closed (account feature disabled) if the secret is missing/short so plaintext PII is never persisted.
5. **Server-side OTP service (REAL logic, delivery-provider dependent).** `server/lib/otp-service.ts` — generated with `crypto.randomInt`, stored ONLY as HMAC-SHA256 hash, constant-time verify, TTL, single-use-on-success, attempt cap, resend cooldown, per-key rolling-window issue cap. Raw code never logged/returned.
6. **OTP rate limiting (REAL).** `server/lib/rate-limiter.ts` rolling window; used for KYC and login (`max 5 login attempts per IP/hour`, `server/index.ts:764`). Note: in-memory, single-process.
7. **Secure server sessions (REAL).** `server/account/session.ts` — 32-byte random tokens, SQLite-backed, TTL (default 24h), `HttpOnly / SameSite=Lax / Secure` cookie, invalid/expired → 401 + cookie cleared (`middleware.ts`).
8. **Server-authoritative login (REAL gate).** `AccountService.login()` (`server/account/service.ts:456`) is the only session-minting path, requiring password verify + `identityVerified` + all three factor flags (`googleLinked`, `smsOtpVerified`, `whatsappOtpVerified`). Endpoint rate-limited; `/api/v1/account/login` never accepts a face/score.
9. **Fail-closed behavior across central paths (REAL).** Missing/ambiguous KYC response, absent face capability, absent reference, expired/replayed Google state, missing encryption secret, and unconfigured factors all resolve to `unavailable`/`error` rather than fabricated success.
10. **Liveness engine — in-memory motion + frame-quality (REAL but limited).** `server/.../src/liveness/vision-provider.ts`, `state-machine.ts`, `camera-capture.ts`. Genuinely: captures a downsample grey grid, computes frame-to-frame motion + brightness/contrast quality, drives a pure randomized motion-challenge state machine. Camera permission is explicit; tracks are stopped; raw pixels are not retained. `biometricActions`/`faceDetection` advertise `false` and are never faked.
11. **Face-verification provider boundary + state machine (REAL architecture).** `src/liveness/face-verification.ts` (`FaceVerificationProvider`, `IN_MEMORY_FACE_PROVIDER` fail-closed), `src/liveness/login-face-machine.ts` (no event sets `matched=true` directly; absent capability/reference ⇒ `verification_unavailable`).
12. **Privacy invariants enforced by tests.** `tests/account-privacy.test.ts` guards no raw PII / password / selfie / biometric persistence and no on-chain payload text.
13. **Google OAuth session security primitives (REAL).** `server/account/google-provider.ts` — cryptographically random per-wallet `state` + `nonce`, TTL (10 min), single-use, replay-rejected, `safeEqual` nonce check, code consumed before exchange. Credentials only from server env vars.

---

## B. CURRENTLY DEMO

These are explicitly labeled demo in the repository README and/or source. They exist and run, but they are not production identity verification.

1. **Deployed CI/README: officer authorization is demo-only.** `src/auth/roles.ts` treats `VITE_DEMO_OFFICER_ADDRESSES` as officers, or offers client-side "Simulate Officer Sign-In (DEMO)". README: "client-side and trivially bypassable. It shapes the UI/UX correctly; it does not secure anything." (Out of strict scope of this identity task, but flagged as a real/security boundary.)
2. **`src/verify/face-match.ts` — demo face matching.** Head comment: "DEMO ONLY — explicitly NOT a real biometric/facial-recognition matcher and NOT an authorized Aadhaar/UIDAI verification." Crude client-side perceptual correlation; UI must be labeled "Demo Identity Verification." It is NOT a legitimate biometric reference matcher.
3. **`/api/v1/account/identity-verified` sets `identityVerified=true` on a bare `confirmed:true`.** `server/index.ts:742` → `markIdentityVerified` (`service.ts:440`) records the boolean with NO Aadhaar proof, NO face match, and NO server-computed evidence. The only gate is "authenticated + confirmed:true". **This is the single most important demo behavior that must be replaced before login can be called real.**

---

## C. CURRENTLY PROVIDER-READY

Real architectural boundary exists and the service fails closed today; a live external integration is the missing piece.

1. **SMS OTP delivery.** `smsDelivery` in `service.ts`; `config.account.smsConfigured = SMS_GATEWAY_PROVIDER !== ''`. Real now: issue/verify, hashing, TTL, single-use, cooldown, rate limit. Missing: a real SMS gateway transport + credentials → feature currently `unavailable`.
2. **WhatsApp OTP delivery.** Same pattern (`whatsappDelivery`, `WHATSAPP_GATEWAY_API_TOKEN`). Missing: real WhatsApp Business API/Cloud API transport + credentials.
3. **Google OAuth exchange.** `GoogleProvider` boundary + state/nonce/`google/begin`-`complete` routes exist. Missing: real Google Cloud OAuth client (ID + secret) with correctly configured redirect/authorized origins, plus a real `exchange` that calls Google's token/userinfo endpoints and validates issuer/audience. Currently `googleConfigured=false` ⇒ unavailable.
4. **Aadhaar-linked KYC (mobile-link check).** `server/services/identity-provider.ts` — a genuine HTTP adapter with both a **direct link-check** mode and a **challenge/submit** OTP mode, fails closed on ambiguous responses. Missing: authorized vendor credentials (`AADHAAR_KYC_API_TOKEN`, `_BASE_URL`) and confirmation the vendor contract is available. Currently `available=false` and the UI reports "not available in this demo." Official UIDAI verification requires an authorized integration — do NOT claim it without one.
5. **Login face verification (Part 6).** Provider boundary + fail-closed state machine + honest UI + server snapshot (`faceVerificationState` returns `providerAvailable:false, hasReferenceIdentity:false`). Missing: a real CV provider and a legitimate enrolled reference. Currently `provider_unavailable` by design.

---

## D. NOT IMPLEMENTED

1. **Real camera-based liveness** — the only implemented liveness signals are **motion** and **frame brightness/contrast**. There is **no face detection, no face landmarks, no blink/eye-action observation, no head-pose direction, no open/closed-mouth action, and no per-action semantic verification.** Challenges that need `biometricActions` or `faceDetection` are correctly excluded (fail closed), so the current liveness proves "something moved," not "a live face moved as instructed."
2. **Legitimate biometric reference enrollment** — no schema, storage, or flow exists for a registered, consented reference face. No biometric material of any kind is currently stored.
3. **Real live-face-vs-reference matching** — no embedding model, no comparison, no reference store.
4. **Replay/photo/video-attack resistance** — no depth/silent-liveness/texture/iridescence checks; a static image or replayed video could satisfy the (motion-only) engine if it keeps moving. Real resistance is unimplemented.
5. **Official Aadhaar identity verification** — not integrated with any authorized vendor; no real KYC call is currently made.
6. **Live Google OAuth** — no real credential exchange.
7. **Live SMS/WhatsApp delivery** — no real gateway calls.
8. **Production backend deployment** — the Level 3 server is not confirmed deployed/reachable; only the frontend is live on Vercel.
9. **Production operational hardening** (see §G for specifics).

---

## E. EXACT WORK REQUIRED TO MAKE EACH PART REAL

### E1. Real registration liveness (Part 4 → real)
Goal: prove a live person is present and following randomized active challenges, resistant to replay/photo/video.

Required components:
- **Face detection** (bounding box per frame).
- **Face landmarks** (e.g. 68-point / MediaPipe 478-point) to observe: **eye openness (blink)**, **head pose (yaw/pitch)**, **mouth openness**, optionally **gaze/iris**.
- **Randomized active challenges** chosen server-side: e.g. "blink twice", "turn left/right", "look up/down", "open mouth", "turn away and back". The instruction must be unknown to the attacker in advance.
- **Per-action semantic verification** — the engine verifies the observed landmark change matches the requested action (not just "any motion").
- **Quality gate first** — require a detectable face at adequate size/lighting/focus before challenges (reuse/extend the existing frame-quality concept to face-level).
- **Fail-closed** — if any required capability/landmark pauses or error, abort to `vision_unavailable` / retry; never degrade to "motion only".
- **Replay/photo/video resistance** where supported — optional depth or silent-liveness signals; at minimum, reject a static plane (no 3D/eye-blink variance) and require action specificity.

Integration points (current honest seams to implement behind):
- `src/liveness/vision-provider.ts` → set `faceDetection:true`, `biometricActions:true` only when a real engine is present.
- `src/liveness/challenges.ts` → re-enable `blink-twice` / `look-up` / `look-down` / `raise-hand` (they already exist and are correctly suppressed until capability is real).
- `src/liveness/state-machine.ts` → add a face-detected quality gate + per-action verdict events WITHOUT changing the fail-closed philosophy or the no-direct-"human=true" rule.

### E2. Secure biometric reference enrollment
Goal: establish a legitimate, consented, server-bound reference identity used ONLY for matching; never leaked.

- **Where:** server-side private store (SQLite extension or a separate K/V); **never** `localStorage`, URLs, logs, or frontend source; **never** on-chain.
- **What is stored:** a protected embedding/compact biometric template — never raw images — encrypted at rest with a **separate** key from account PII.
- **Enrollment flow (must be real, not demo):** user connects wallet → verifies own factors → captures a short live reference session (multiple frames) → a real face model extracts an embedding → embedding is encrypted and bound to `accountId` + a unique `referenceId` alongside a nonce. Consent + revocability: store a per-account consent flag and a `revokedAt`; allow deletion (private delete only; nothing on-chain).
- **Key management:** derive an `ACCOUNT_BIOMETRIC_ENC_SECRET` server-only env secret (>=32 bytes), kept out of VITE. Use a distinct key than PII so a PII compromise does not expose biometrics and vice versa. Support key/secret rotation via re-encryption.
- **Never store raw face images** beyond the enrollment capture window; discard frames after embedding.

### E3. Real login face matching
Goal: match the live camera face against the enrolled reference, fail closed.

- **Provider:** a real inference engine (see §F) that (a) detects the live face, (b) runs an active liveness action set, (c) produces an embedding, (d) compares embedding distance/similarity to the stored reference embedding with a decision threshold.
- **Where the match runs:** server-side is safest (reference stays on server; client never sees the template). The camera frames → downsample → POST a short-lived, single-use, expiring capture token to a server endpoint that runs detection/embedding and compares server-side. This avoids shipping the reference to the browser and avoids storing raw frames on the server.
- **Tie to `/api/v1/account/login/face-verification`:** change `faceVerificationState` from a static `false/false` to reflect a real `providerAvailable` + per-account `hasReferenceIdentity`; add a server route that performs verification and returns only a verdict (never the raw embedding). The session gate must accept the server-computed `matched` only.
- **Replace the login gate:** login must require a real server success from this route when a reference exists; when no reference exists, the system should fail closed (or require enrollment first) — never silently succeed.

### E4. Real OAuth/OTP providers (Google / SMS / WhatsApp)
- **Google (real OAuth):** create a Google Cloud OAuth 2.0 client; set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (server-only) and a real `exchange` that posts the auth code to `https://oauth2.googleapis.com/token`, validates `iss`, `aud`, `exp`, `nonce` from the ID token. Add a server `GET /api/v1/account/google/callback` OAuth redirect route (currently only `/begin` and `/complete` exist; there is no real redirect endpoint). Configure authorized redirect URI `https://<backend>/api/v1/account/google/callback` and the frontend origin.
- **SMS:** wire `smsDelivery.send` to a real gateway (Twilio/Twilio Verify/MessageBird) with server-only credentials; keep hashing/TTL/single-use/cooldown/rate-limit in the OTP service (already correct).
- **WhatsApp:** wire `whatsappDelivery.send` to WhatsApp Business/Cloud API with server-only credentials; keep same OTP guarantees.
- **Never** expose these credentials through VITE/`VITE_*` public frontend variables.

### E5. Real identity/Aadhaar provider
- **Authorize first:** obtain an actual authorized integration with a UIDAI KYC pipeline or an approved vendor (the adapter in `identity-provider.ts` already targets this). Do not claim official verification without it.
- **Wire the env contract:** populate `AADHAAR_KYC_PROVIDER`, `_API_TOKEN`, `_BASE_URL`, `_MOBILE_LINK_PATH` (server-only). Confirm the vendor's actual response schema so the `data.linked`/`registered` mapping is correct.
- **Gate login on real identity:** replace `markIdentityVerified` (currently bare `confirmed:true`) so `identityVerified=true` is set **only after** a real KYC/link-check (or a real face+capture) succeeds server-side, with a nonce/expiry so a stale result cannot be replayed to mint a session.

### E6. Backend production deployment
- Deploy the Node server (`server/index.ts`) behind TLS with an HTTPS URL.
- Set producer env (server-only): `ACCOUNT_ENC_SECRET`, `ACCOUNT_BIOMETRIC_ENC_SECRET`, `OTP_HASH_SECRET`, `GOOGLE_CLIENT_*`, `SMS_GATEWAY_PROVIDER`, `WHATSAPP_GATEWAY_API_TOKEN`, `AADHAAR_KYC_*`, `SMTP_*`, `REGISTRY_OFFICER_API_TOKEN`, `VERIFY_SERVER_ALLOWED_ORIGIN` to the live frontend origin.
- Point `VITE_VERIFICATION_API_URL` at the backend **public URL only** — never a secret.
- Consider a persistent connection-pooled store; the current single-process in-memory rate limiter and Google challenge map should move to the DB/Redis for horizontal scaling (see §G).

### E7. Final documentation/evidence
- Update README Level 3 status from "provider-ready" to "real" only for items actually real the day of submission.
- Add a test screenshot and a Level 3 demo video.

---

## F. PROVIDER OPTIONS / LIBRARIES TO EVALUATE

Selection criteria: actually usable in this React + Node + TypeScript project, with a server-side reference (never client-side only), and not adding dependencies purely to make tests pass. Evaluate for: licensing, on-device vs hosted cost, PII/embedding privacy, latency, accuracy, and UIDAI/Aadhaar authorization.

1. **Face detection + landmarks + embedding (real CV):**
   - **MediaPipe Face Detector / Face Mesh / Face Geometry** — on-device landmark/pose/blink detection; the landmark changes (eye aspect ratio, head yaw/pitch) directly power liveness actions. Strong fit for the liveness engine.
   - **InsightFace (ArcFace) / FaceNet** — strong embedding models for 1:1 face matching; model can run server-side (ONNX/`@xenova/transformers` in Node) so the reference stays server-side.
   - **Hugging Face `@xenova/transformers`** — JS/Node port of transformers (includes face analysis models) usable server-side without a Python runtime.
   - Evaluate **cloud biometric APIs** only if they accept "send ephemeral live frame, return verdict" with server-side template storage and clear data-retention/consent terms. Always filter to providers that never require shipping the raw reference template to the browser.
2. **Liveness / anti-spoofing (replay/photo):**
   - **Silent-liveness (single image) models** (e.g. FAS models), and **active-liveness** via the landmark challenge sequence above.
   - Depth/screen-glare/iridescence checks if a provider supports them.
3. **OTP delivery:** **Twilio Verify / Twilio Programmable SMS**, **TeleSign**, **MessageBird**, or regional gateways — choose for your market; all are real transports.
4. **WhatsApp:** **WhatsApp Business Platform (Cloud API)** or **Meta WhatsApp Cloud API** via a hosted provider.
5. **Google OAuth:** native **Google Identity Platform** (OAuth 2.0 + OpenID Connect) with server-side token verification.
6. **Aadhaar/identity KYC:** an **UIDAI-authorized** KYC vendor (the existing adapter is vendor-agnostic; e.g. Surepass-style vendors) — only after you obtain authorization and credentials. Do not use an unofficial/unapproved Aadhaar source.

**Do not** add libraries until you have chosen a provider and confirmed it is buildable/valid in CI here (no orphaned "to make tests pass" deps).

---

## G. SECURITY + PRIVACY REQUIREMENTS

1. **Never on-chain / never in clear:** biometrics, embeddings, raw images, Aadhaar, passwords, OTPs. Extend `account-privacy.test.ts` to sweep for the new biometric columns/serialization paths too.
2. **Server-authoritative:** the browser must never assert "matched" or "human"; the server decides via real computation. Existing `login()` already ignores any client face/score field — keep that invariant; extend it to the new routes.
3. **Separate keys:** distinct server-only AES keys for PII vs biometric templates; both fail closed if unset.
4. **Reference integrity + consent:** store only encrypted embeddings + `accountId` + `referenceId` + consent + `revokedAt`; support delete/revoke; no raw frames retained.
5. **Session hygiene:** keep `HttpOnly/SameSite/Secure`; set `Secure` on non-localhost; rotate/expire sessions; add account-level concurrent-session limits.
6. **OTP guarantees:** preserve hash/TTL/single-use/cooldown/rate limit; move in-memory OTP + Google challenge + rate limiter state into the persistent store (or Redis) so restarts/scale do not weaken it.
7. **OAuth:** only an OIDC-validated ID token (iss/aud/exp/nonce) completes the factor; real redirect endpoint; single-use state+nonce (already implemented) retained.
8. **Replay/attack resistance:** real liveness must reject static/photo/video; server-side capture tokens must be single-use and short-TTL.
9. **No secret via VITE:** all provider secrets are server env only; VITE carries only public URLs.
10. **Fail closed everywhere:** any provider/reference/quality/network error ⇒ `unavailable`/retry, never success.

---

## H. TEST PLAN (to prove each part is REAL)

Continue the existing `node:test` pattern in `tests/`. Intended coverage:

**Registration liveness**
- H1 real face detected → quality gate passes (mock a faces presenter).
- H2 blink-twice observed via landmark EAR pattern → success; a static face with no blink → fail.
- H3 head-turn challenge matches yaw direction; wrong direction → `challenge_failed`.
- H4 replay/photo attack (static plane, no 3D/blink variance) rejected.
- H5 quality failure (no face / too dark / too far) → fail closed, retryable.
- H6 missing capability ⇒ `vision_unavailable`, never motion-only fallback.

**Biometric reference enrollment**
- H7 raw image never persisted; only encrypted embedding stored.
- H8 reference bound to `accountId` + `referenceId`; consent + `revokedAt` honored.
- H9 encryption uses a distinct key; missing key ⇒ enrollment fails closed.
- H10 deletion/revocation removes template; match after revoke fails.

**Login face matching**
- H11 genuine match (same live subject vs reference) → `matched`.
- H12 genuine mismatch (different subject) → `mismatch`.
- H13 no reference ⇒ `verification_unavailable`; no fabricated match.
- H14 provider unavailable ⇒ fail closed.
- H15 client-supplied `matched=true` never accepted (mirror existing F1 test).

**Privacy invariants**
- H16 sweep asserts no biometric/raw-PII serialized to ledger/localStorage/URLs/logs/frontend source (extend `account-privacy.test.ts`).

**OTP (SMS/WhatsApp)**
- H17 expiration; H18 single-use (reuse rejected); H19 attempt-cap; H20 cooldown; H21 per-key rate limit; H22 raw code never returned/logged.

**OAuth**
- H23 state/nonce required; H24 replay rejected; H25 expired state rejected; H26 bad issuer/audience/nonce ⇒ unauthorized; H27 real callback exchange path is exercised.

**Server-authoritative login**
- H28 session minted only when password + factors + real identity hold; H29 login rate limit.

**Regression:** keep the existing 318 tests passing (Level 2 + Level 3 + privacy + auth + liveness + face + registry + account).

---

## I. DEPLOYMENT / SECRET REQUIREMENTS

**Backend deployment (needed so real flows are reachable live):**
- Run `server/index.ts` on Node ≥22 behind TLS with a stable HTTPS origin and `VERIFY_SERVER_ALLOWED_ORIGIN` = the Vercel frontend origin (CORS).
- Persist SQLite at a stable `ACCOUNT_DB_PATH`; treat it as private state (backups encrypted).
- Provide a `Procfile`/`start` command and a health/`/` route currently served by `server/index.ts`.

**Server-only env (never VITE):**
- `ACCOUNT_ENC_SECRET` (≥16 chars), `ACCOUNT_BIOMETRIC_ENC_SECRET` (≥32 chars), `OTP_HASH_SECRET` (≥16 chars), `REGISTRY_OFFICER_API_TOKEN`, `SMTP_*`/`EMAIL_FROM`, `SMS_GATEWAY_PROVIDER`, `WHATSAPP_GATEWAY_API_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AADHAAR_KYC_PROVIDER`, `AADHAAR_KYC_API_TOKEN`, `AADHAAR_KYC_BASE_URL`, `AADHAAR_KYC_MOBILE_LINK_PATH`.

**Frontend-only (public, non-secret):**
- `VITE_VERIFICATION_API_URL` — the backend's **public** HTTPS URL.
- `VITE_NETWORK_ID`, `VITE_DEFAULT_CONTRACT`, `VITE_DEMO_OFFICER_ADDRESSES`, `VITE_PRIESTATE_*` demo secrets — these are for the on-chain demo circuits, **not** for identity credentials. Keep any real OAuth/biometric secrets out of VITE.

**Secrets never exposed:** no `VITE_GOOGLE_CLIENT_SECRET`, no `VITE_SMS_TOKEN`, no VITE Aadhaar keys. `.env` is gitignored; keep only `.env.example` (documented variable names, no values — as it is today).

---

## J. IMPLEMENTATION ORDER (prioritized)

1. **Real registration liveness** — add a real face-detection + landmark engine server-side (or a well-selected on-device model feeding a server verdict), re-enable the existing blink/head-pose challenges, add a face-quality gate, and add replay/photo resistance. Verify with liveness tests (H1–H6).
2. **Secure biometric reference enrollment** — server-side encrypted embedding store, distinct key, consent/revoke/delete, not-on-ledger. Verify with H7–H10.
3. **Real login face matching** — server-side live-face-vs-reference, tie to `/api/v1/account/login/face-verification`, keep fail-closed, prove match/mismatch/none. Verify with H11–H15.
4. **Real OAuth/OTP providers** — Google OAuth real redirect + token validation; SMS + WhatsApp real transports; keep all OTP guarantees. Verify with H17–H27.
5. **Real identity/Aadhaar provider** — obtain and wire an authorized KYC integration; make `identityVerified` depend on a real server-computed success (replace the bare `confirmed:true`). Verify with privacy + identity determinism.
6. **Backend production deployment** — TLS server, server-only env, stable data store, CORS to live frontend; confirm the live Level 3 flows are reachable, not just the frontend.
7. **Final documentation/evidence** — update README status truthfully, add test screenshot + Level 3 demo video, update the product proposal to match the now-real features.

Cross-cutting: extend privacy-invariant tests and security tests continuously; do not break the existing 318-test suite; never weaken the fail-closed or no-ledger-PII guarantees.

---

## Findings Summary

- **Solid, real foundation:** wallet binding, scrypt password hashing, AES-256-GCM PII-at-rest, server-backed sessions, HMAC OTP service with TTL/single-use/cooldown/rate-limit, server-authoritative login gate, fail-closed OTP/Google/KYC/face boundaries, and privacy-invariant tests. These are genuinely real and should be preserved.
- **The biggest demo gap:** `/api/v1/account/identity-verified` accepts a bare `confirmed:true` with no real server-computed evidence — this is the single point that lets a login be marked identity-verified without a real identity check. It must be replaced by a real server-authorized identity proof (face OR KYC).
- **Liveness is motion-only, not facial liveness:** no face detection/landmarks/blink/head-pose; the honest engine correctly fails closed rather than faking them.
- **No biometric reference exists; no storage, no match path.**
- **Google/SMS/WhatsApp/Aadhaar are genuine provider boundaries that fail closed,** requiring live credentials + (for Google) a real redirect callback route.
- **Backend is not confirmed deployed**; only the frontend is live.
- **In-memory OTP/challenge/rate-limit state** should move to persistent storage for production hardening.

File created: `docs/REAL-IDENTITY-VERIFICATION-PLAN.md` (this document).
No application code, contract, wallet, deployment, or tests were modified. No dependencies installed. Nothing committed or pushed.

---

## K. PART 7 — IMPLEMENTATION LOG (real landmark liveness + live location)

This section records what Part 7 actually built and, equally, what it does NOT claim. It is the plan/audit doc — the **product proposal is intentionally NOT updated** per Part 7 scope.

### K1. What is now REAL (implemented and tested)

1. **Genuine camera-based liveness via 68-point face landmarks.** `@vladmandic/face-api` (browser, vendored TFJS esm; **not** the Node `@tensorflow/tfjs-node` build) runs `tinyFaceDetector` + `faceLandmark68TinyNet` models served from `public/models/`. Per frame it returns a normalised `FaceLandmarkFrame` (bounding box + 68 landmarks in dimensionless 0..1 space — never raw pixels). This is real inference, not motion-only.
2. **Active challenge verification of real landmark signals.** `src/liveness/landmark.ts` derives per-frame **Eye Aspect Ratio (EAR)** (blink), a **head-yaw proxy**, and **face area**. `landmark-verifier.ts` requires *specific, per-action* semantics:
   - `blink-twice` → two independent close→open EAR dips;
   - `turn-left`/`turn-right` → a yaw excursion to the correct side (sign + magnitude), fixing a genuine bug where an over-rotation to the *wrong* side could satisfy the challenge;
   - `move-closer` → a real face-area increase;
   - `move-head` → ≥2 yaw direction flips.
   Only `VERIFIABLE_ACTIONS` (the five above) are offered; `look-up`/`look-down`/`raise-hand` are **excluded** because the 68-point mesh cannot genuinely verify them, and the verifier returns `invalid` (fail closed) for them rather than faking a pass.
3. **Mandatory live browser geolocation during the session.** `location-watcher.ts` wraps `navigator.geolocation.watchPosition` with `enableHighAccuracy`, injectable `GeoApi` for tests, and honest state mapping (`location_denied`/`unavailable`/`timeout`). The pure validator (`location.ts`) fails closed on missing/non-finite/out-of-range/stale (>30s)/coarse (>100m) fixes. Camera, landmark liveness, **and** a fresh accurate location fix are all required before registration advances.
4. **Server-authoritative evidence boundary.** NEW `POST /api/v1/account/identity-evidence` (additive; the existing `identity-verified` demo path is untouched). `rejectIdentityEvidence` (pure) refuses missing evidence, `livenessPassed!==true`, missing/invalid/stale/coarse location. `recordIdentityEvidence` never persists or echoes raw coordinates/landmarks/nonce. The registration page only advances when the server accepts.
5. **Fail-closed provider boundary.** `realLandmarkProvider` lazily imports face-api; if the module/model fails to load, capabilities advertise **no** `faceDetection`/`biometricActions` and the component stays at `vision_unavailable` — there is **no motion-only fallback** that fakes liveness.

### K2. What each signal proves — and what it does NOT

- Landmark liveness proves a *face was present on camera and performed instructed eye/head/approach motions* — genuine short-range evidence of a live person in front of the camera at that moment.
- Browser geolocation proves the *browser/OS-reported position* (Wi‑Fi/cell/GPS derived) with the user's permission and a fresh, accurate fix. It is **NOT** a cryptographic physical-location attestation; it is spoof-able in principle. The UI and code say so; it is used only as a freshly-observed, user-granted signal, never claimed to prove physical presence.
- **Not implemented:** depth/silent-liveness/replay resistance, biometric embedding, **face matching against an enrolled reference** (there is still no reference store), and any official/Aadhaar identity verification. Liveness ≠ face match ≠ location; these are distinct signals and Part 7 deliberately does not conflate them.

### K3. Provider-ready / not available

- The landmark+location pipeline is browser-side and functional today. A **server-side verdict** for liveness (uploading ephemeral frames to a server that runs detection + a signed nonce) remains a future hardening step; the current server boundary validates client-observed evidence rather than re-running CV server-side.
- Real anti-spoofing (replay/photo/video), silent-liveness, and face matching require a CV provider/reference store (see §F) — not yet integrated.

### K4. Location tracking behavior

- Location is requested only inside the active registration identity session and only via the standard `watchPosition` prompt.
- A single fresh, accurate fix (≤30s old, ≤100m) is required to complete; fixes older/coarser/missing fail closed.
- The watcher is **stopped and cleared on every exit** (complete / fail / cancel / unmount). No continuous background tracking.

### K5. Privacy / retention / security behavior

- **Never persisted or transmitted:** raw camera frames, landmarks, embeddings, or raw coordinates. Location evidence is sent as a range-checked descriptor (lat/lon/accuracy/timestamp/nonce) to the server boundary, which validates and **discards** it — it is not stored, not echoed, not logged, not placed in `localStorage`, URLs, query strings, or frontend env.
- **No ledger writes:** the account/liveness/privacy modules reference no contract-submit surface; `account-privacy.test.ts` (including a new Part 7 sweep) enforces this.
- **Server-authoritative:** the server decides acceptance via `rejectIdentityEvidence`; a bare client boolean or self-asserted `livenessPassed`/location is rejected.
- **Dependencies added:** `@vladmandic/face-api@^1.7.15` (browser-only, lazy) + a `copy-face-models` build script. No provider secrets introduced.

### K6. Tests added for Part 7

- `tests/liveness-real.test.ts` — per-action verifier semantics, fail-closed non-verifiable actions, provider fail-closed on module load failure, capability honesty.
- `tests/location-verification.test.ts` — pure validator denials, watcher state via an injectable fake `GeoApi`, permission/denial mapping, idempotent stop.
- `tests/account-privacy.test.ts` (extended) — server `rejectIdentityEvidence`/`recordIdentityEvidence` boundary, no-raw-coords persistence, Part 7 modules reference no persistence/logging surface.

### K7. Verification status (Part 7)

- `npm test` — full suite **346 pass / 0 fail** (was 318 baseline; +28 new Part 7 assertions/tests).
- `npm run typecheck` — clean (`tsc --noEmit`).
- `npm run build` — clean.
- Midnight Compact contract, wallet, and deployed state **untouched**; no secrets/PII/biometric/location data introduced. Nothing committed or pushed.

---

## Part 8 — Real biometric enrollment + real server-authoritative login face matching (LOG)

### L1. What changed (security)

- **Removed the insecure trust path.** The old `/api/v1/account/identity-verified` route and `markIdentityVerified` service method (which set `identityVerified=true` from a bare `confirmed:true`, with no server-computed evidence) are **gone**. The client demo consumer of that endpoint was rewired.
- `identityVerified` can now only become `true` via **genuine server-side biometric enrollment** (`enrollBiometricReference` / `replaceBiometricReference`), where the server derives + encrypts the reference itself.
- **Login face matching is now server-authoritative.** `verifyBiometricMatch` takes only `{ verificationToken, liveEmbedding }`. Live-vs-reference comparison runs **on the server** (decrypts its own stored reference, computes cosine similarity); the client's `matched`/`score` — even if sent — cannot influence the verdict (verified by an over-HTTP test that attaches fake `matched`/`score` claims).

### L2. Reference enrollment + encrypted at rest

- Reference embeddings are encrypted at rest under a **separate key**: `ACCOUNT_BIOMETRIC_ENC_SECRET` → `deriveBiometricEncryptionKey` (SHA-256, domain-separated `biometric-ref:v1:`) → AES-256-GCM `encryptBiometricReference`. Distinct from the general account encryption secret.
- `AccountRecord` gained `biometricReferenceCipherText`, `biometricReferenceVersion`, `biometricEnrolledAt`, `biometricConsentAt`, `biometricRevokedAt`; `PublicAccountView` reports a non-sensitive `enrollmentState` (`not_enrolled|enrolled|revoked|unavailable`).
- SQLite store + `db.ts` migration add the columns; `applySchema` runs an idempotent `ALTER TABLE` loop so pre-existing DBs upgrade cleanly.
- Enrollment lifecycle: `beginBiometricEnrollment` mints a single-use, short-TTL session token → `enrollBiometricReference` enforces explicit consent, ≥`minEnrollFrames` usable frames, low mutual `spread`/self-similarity, then encrypts + stores. Revoke/replace bump `referenceVersion` (version-bound tokens fail safely). Every path fail-closes when the provider is unconfigured, consent missing, embeddings unusable, session replayed, or reference absent/revoked.

### L3. HTTP + config

- `MAX_BODY_BYTES` raised `8 KiB → 128 KiB` (real enrollment bodies ~10.6 KiB) — the root cause of the earlier "fetch failed" on enrollment complete.
- Five routes replace the removed one: `biometric/enrollment/begin`, `.../complete`, `biometric/revoke`, `biometric/verification/begin` (public; body carries wallet + binds token to wallet & reference version), `biometric/verification/complete` (auth-gated; server returns verdict only).
- Config: `account.biometricEncryptionSecret` + `VerificationServerOverrides.accountBiometricEncryptionSecret` + `AccountServiceOptions` (`biometricEncryptionSecret`, `biometricConfig`, `biometricSessions`).

### L4. Client changes

- `src/auth/account-api.ts`: removed `markIdentityVerified`; added `beginBiometricEnrollment` / `completeBiometricEnrollment` / `beginBiometricVerification` / `completeBiometricVerification` (client sends only the token + embedding; never a self-affirmed boolean).
- `src/pages/IdentityVerificationPage.tsx`: `handleConfirm` no longer calls `markIdentityVerified(address, true)`; it runs the real begin→complete enrollment flow. A clearly-labelled `projectDemoEmbedding` (in `src/verify/face-match.ts`) maps the page's crude perceptual signature to a normalized 128-d usable vector purely to exercise the real server path — it is a **demo stand-in** for face-api inference, never presented as real.

### L5. Tests added / migrated

- `tests/biometric-vectors.ts` (new): deterministic usable 128-d vectors (`referenceVector`, `sameFaceVector`, `differentFaceVector`, `enrollmentVectors`).
- `tests/biometric.test.ts` (new): pure math, session nonce lifecycle, insecure-path-removed assertions, enrollment lifecycle (consent/replay/low-quality/unconfigured fail-closed/encrypted-at-rest/revoke/replace version bump), matching (same face / impostor / token replay / reference-version binding / ignored client claims).
- `tests/account-persistence-server.test.ts`: added a full over-HTTP round-trip — enroll → begin verification → same-face `matched` / different-face `mismatch` / replayed-token rejection, with fake client claims attached to prove the server is authoritative.
- Migrated every prior `identity-verified`/`markIdentityVerified` test usage to genuine server-side enrollment (`tests/account-auth.test.ts`, `tests/login-auth.test.ts`, `tests/account-persistence-server.test.ts`, `tests/account-persistence.test.ts`, `tests/account-privacy.test.ts`, `tests/face-verification-login.test.ts`).

### L6. Verification status (Part 8)

- `npm test` — full suite **369 pass / 0 fail** (was 346 at end of Part 7; +23 net new Part 8 tests/assertions incl. the server-authoritative over-HTTP round-trip).
- `npm run typecheck` — clean (`tsc --noEmit`).
- `npm run build` — clean.
- `account-privacy.test.ts` still asserts the server never logs/returns secrets/tokens and never stores raw biometrics (only encrypted ciphertext + metadata); the Part 8 fingerprint sweep is preserved.
- Midnight Compact contract, wallet, and deployed state **untouched**; no secrets/PII/biometric/location data introduced. Nothing committed or pushed.