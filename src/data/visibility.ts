// PRIESTATE — Record visibility rules for normal users (USER role).
//
// USER may see:
// - their own application/property information (demo binding, see
//   DEMO_USER_PROPERTY_IDS in src/auth/roles.ts)
// - explicitly public registry information (finalized APPROVED records)
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
