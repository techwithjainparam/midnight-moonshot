// PRIESTATE — Frontend Google OAuth popup flow (J.4 real Google sign-in).
//
// The REAL OAuth flow is server-authoritative:
//
//   begin()        → POST /google/begin  returns { state, nonce, authUrl }
//   popup          → window.open(authUrl) → Google → server callback, which
//                    exchanges the code, verifies the ID token signature and
//                    nonce against the remote JWKS, and 302s to the app with
//                    `?google=pending`.
//   popup landing  → announces to the opener, then closes.
//   opener         → POST /google/complete { state, nonce } → server marks the
//                    account Google-linked ONLY if the challenge was set
//                    `redirectVerified` by a successful server-side exchange.
//
// Security invariants:
//   * the openAuthorizationCode is ONLY ever present in the server callback; the
//     browser never sees or forwards it;
//   * the state + nonce challenge lives only in component memory — never in
//     localStorage/sessionStorage, never in a URL, never in logs;
//   * a popup message alone can never link an account: `complete` requires the
//     server-side `redirectVerified` flag that only a verified OAuth redirect
//     sets (see server/account/google-provider.ts) — so forged window messages
//     fail closed with `unauthorized`/`bad-state`.

import { useCallback, useEffect, useRef, useState } from 'react';
import { beginGoogle, completeGoogleWithState } from './account-api';

const POPUP_NAME = 'priestate-google-signin';
const HANDLER_KIND = 'priestate:google-signin-pending';

export interface GoogleChallenge {
  readonly state: string;
  readonly nonce: string;
}

export interface GoogleSignIn {
  challenge: GoogleChallenge | null;
  popupOpen: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  begin: () => Promise<void>;
  checkStatus: () => Promise<void>;
  reset: () => void;
}

/** True when the current page is the OAuth completion landing (`?google=pending`). */
export function hasGooglePendingQuery(): boolean {
  return new URLSearchParams(window.location.search).get('google') === 'pending';
}

/** POPUP-SIDE: notify the opener that the server exchange succeeded, then close. */
export function announceGooglePending(): void {
  if (!window.opener || !hasGooglePendingQuery()) return;
  try {
    window.opener.postMessage({ kind: HANDLER_KIND, pending: true }, window.location.origin);
  } catch {
    // A blocked/cross-origin opener cannot be notified; the initiator falls
    // back to polling its own `checkStatus()` against the server.
  }
  window.close();
}

let popupLandingInitialized = false;

/**
 * Initialize the popup-side announcement handler. Run once at app boot so the
 * completion landing works on ANY route (the server 302s to the app root).
 */
export function initGooglePopupLanding(): void {
  if (popupLandingInitialized) return;
  popupLandingInitialized = true;
  announceGooglePending();
}

type LinkSignalListener = () => void;
const linkSignalListeners = new Set<LinkSignalListener>();

// A single global listener funnels popup completion signals to whichever
// Google sign-in flow is currently live. The signal is only a *nudge*: the
// actual link is still gated by the server-side redirectVerified check.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.origin !== window.location.origin) return;
    if (ev.data?.kind !== HANDLER_KIND || ev.data?.pending !== true) return;
    linkSignalListeners.forEach((listener) => listener());
  });
}

function completeWithChallenge(
  walletAddress: string,
  challenge: GoogleChallenge,
): Promise<{ ok: boolean; reason: string; message?: string }> {
  return completeGoogleWithState(walletAddress, challenge).then((r) => ({
    ok: r.ok,
    reason: r.ok ? 'ok' : r.reason,
    message: r.ok ? undefined : r.message,
  }));
}

/** Run a Google sign-in popup flow bound to `walletAddress`. */
export function useGoogleSignIn(walletAddress: string, onLinked: () => void): GoogleSignIn {
  const [challenge, setChallenge] = useState<GoogleChallenge | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const challengeRef = useRef<GoogleChallenge | null>(null);
  const walletRef = useRef(walletAddress);
  const onLinkedRef = useRef(onLinked);
  walletRef.current = walletAddress;
  onLinkedRef.current = onLinked;

  const setChallengeState = useCallback((next: GoogleChallenge | null) => {
    challengeRef.current = next;
    setChallenge(next);
  }, []);

  const complete = useCallback(async (ch: GoogleChallenge): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const r = await completeWithChallenge(walletRef.current, ch);
      if (r.ok) {
        setChallengeState(null);
        setNotice('Google account linked.');
        onLinkedRef.current();
        return;
      }
      switch (r.reason) {
        case 'replay':
          // The challenge was already consumed — treat as already linked and let
          // the caller re-read the authoritative server state.
          setChallengeState(null);
          setNotice('Google account is already linked.');
          onLinkedRef.current();
          return;
        case 'expired':
          setChallengeState(null);
          setError('This Google sign-in challenge expired. Start the step again.');
          return;
        case 'unauthorized':
          setError('The Google sign-in was not verified by the server. Complete the sign-in in the popup, then re-check.');
          return;
        default:
          setError(r.message ?? 'This Google sign-in could not be completed. Try again.');
          return;
      }
    } finally {
      setBusy(false);
    }
  }, [setChallengeState]);

  // A popup completion signal arrives → finalize with the stored challenge.
  useEffect(() => {
    const listener = (): void => {
      const ch = challengeRef.current;
      if (!ch) return;
      void complete(ch);
    };
    linkSignalListeners.add(listener);
    return () => { linkSignalListeners.delete(listener); };
  }, [complete]);

  const begin = useCallback(async (): Promise<void> => {
    if (!walletRef.current) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const r = await beginGoogle(walletRef.current);
      if (!r.ok) {
        setError(r.reason === 'unauthorized' || r.reason === 'session-expired'
          ? 'You need a valid login session to start Google sign-in. Please log in again.'
          : (r.message ?? 'Google sign-in could not be started.'));
        return;
      }
      setChallengeState({ state: r.data.state, nonce: r.data.nonce });
      const popup = window.open(r.data.authUrl, POPUP_NAME, 'popup=yes,width=520,height=660');
      setPopupOpen(Boolean(popup));
      if (!popup) {
        setNotice('The sign-in popup was blocked. Allow popups for this site, then start Google sign-in again.');
      } else {
        setNotice('Sign in with Google in the popup window to link your account.');
      }
    } finally {
      setBusy(false);
    }
  }, [setChallengeState]);

  const checkStatus = useCallback(async (): Promise<void> => {
    const ch = challengeRef.current;
    if (!ch) {
      setError('No Google sign-in challenge is active. Start the step again.');
      return;
    }
    await complete(ch);
  }, [complete]);

  const reset = useCallback((): void => {
    setChallengeState(null);
    setError(null);
    setNotice(null);
    setPopupOpen(false);
  }, [setChallengeState]);

  return { challenge, popupOpen, busy, error, notice, begin, checkStatus, reset };
}