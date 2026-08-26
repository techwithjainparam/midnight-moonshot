// PRIESTATE — Verification provider singletons.
//
// Production user flow uses ONLY these backend-backed providers. The
// DemoLocalOtpProvider is NOT wired here — it survives solely for
// automated tests (see tests/).

import {
  BackendContactVerificationProvider,
  BackendIdentityVerificationProvider,
} from './backend-providers';
import type { ContactVerificationProvider } from './types';

export function createContactVerificationProvider(): ContactVerificationProvider {
  return new BackendContactVerificationProvider();
}

/**
 * App-wide instance. Concrete type exposes the availability health-check
 * used by the UI; callers that only need the verification contract can
 * treat it as IdentityVerificationProvider.
 */
export function createIdentityVerificationProvider(): BackendIdentityVerificationProvider {
  return new BackendIdentityVerificationProvider();
}

/** App-wide instances (created once per page load). */
export const contactVerificationProvider: ContactVerificationProvider = createContactVerificationProvider();
export const identityVerificationProvider: BackendIdentityVerificationProvider =
  createIdentityVerificationProvider();

// Re-export so pages can import everything verification-related from one place.
export * from './types';
