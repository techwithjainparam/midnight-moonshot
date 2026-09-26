// PRIESTATE — Record visibility rules for normal users (USER role).
//
// USER may see:
// - explicitly public registry information (finalized APPROVED records)
//
// Ownership is NOT decided here. `isOwnedByCurrentUser` fails closed (it
// does not treat a connected wallet as the owner of anything), so a
// USER-role viewer only ever sees finalized APPROVED records. Per-wallet
// ownership requires a server-side authorization check; see
// `isOwnedByCurrentUser` in src/auth/roles.ts.
//
// Anything else (other applicants' drafts/pending/rejected applications)
// is restricted. Officer-only data (queue, internal notes) is never part
// of the user view regardless of visibility.

import type { MockProperty } from './mock-properties';
import { isOwnedByCurrentUser } from '../auth/roles';

export type RecordVisibility = 'own-record' | 'public-finalized' | 'restricted';

export function recordVisibility(property: MockProperty): RecordVisibility {
  if (isOwnedByCurrentUser(property.id)) return 'own-record';
  if (property.registrationStatus === 'APPROVED') return 'public-finalized';
  return 'restricted';
}

export function canUserViewRecord(property: MockProperty): boolean {
  return recordVisibility(property) !== 'restricted';
}
