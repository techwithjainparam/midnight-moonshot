// PRIESTATE — Append-only record history (DEMO).
//
// Data model for finalized property records: a record's lifecycle is an
// ordered log of events. Events are ONLY ever appended — never edited,
// never deleted, never reordered. A finalized registration (e.g.
// APPROVED) is represented by the event that finalized it, and any
// future change (status update, ownership transfer, correction) must be
// represented as a NEW authorized event appended after it. Previous
// entries remain in history forever.
//
//   Example shape (see README "Record model"):
//
//     PROPERTY reg-004
//     ├─ 2023-08-05  Registration SUBMITTED      (by USER)
//     ├─ 2023-08-10  Registration APPROVED      (by OFFICER)  ← finalized
//     └─ <future>    OwnershipTransfer …        (new authorized event)
//
// ═══════════════════════════════════════════════════════════════════
// ⚠️  SECURITY LIMITATION — READ THIS
// ═══════════════════════════════════════════════════════════════════
// This module runs in the browser and only demonstrates the append-only
// DATA MODEL and UI. Frontend code alone does NOT make records
// tamper-proof or immutable: this in-memory log can be altered by anyone
// with access to the client runtime. True tamper-resistance must be
// enforced by the appropriate backend / blockchain / cryptographic
// authorization layer (e.g. recording events on Midnight so each event
// is an authorized transaction that cannot rewrite history). The
// existing PRIESTATE Compact contract was intentionally NOT modified to
// simulate this.
// ═══════════════════════════════════════════════════════════════════

import { MOCK_PROPERTIES } from './mock-properties';

export type RecordEventType =
  | 'REGISTRATION_SUBMITTED'
  | 'ZK_VERIFICATION_COMPLETED'
  | 'REGISTRATION_APPROVED'
  | 'REGISTRATION_REJECTED';

export type RecordActor = 'USER' | 'OFFICER';

export interface RecordEvent {
  /** Monotonic sequence number within the property's log. */
  readonly seq: number;
  readonly propertyId: string;
  readonly type: RecordEventType;
  /** ISO date string (demo seed data uses the mock record dates). */
  readonly date: string;
  readonly actor: RecordActor;
  readonly summary: string;
}

/**
 * The single mutation allowed on the store: appending a new event.
 * There is intentionally NO API to update or remove events.
 */
function appendEvent(propertyId: string, event: Omit<RecordEvent, 'seq' | 'propertyId'>): void {
  const log = history.get(propertyId);
  if (!log) return; // Unknown property — nothing to append to.
  const seq = log.length + 1;
  log.push({ ...event, seq, propertyId });
  emit();
}

// ── Store ──────────────────────────────────────────────────────────

const history = new Map<string, RecordEvent[]>();
const listeners = new Set<() => void>();

let snapshotVersion = 0;

function emit(): void {
  snapshotVersion += 1;
  listeners.forEach((l) => l());
}

/** Seed the initial logs from the existing mock registry data. */
function seed(): void {
  for (const p of MOCK_PROPERTIES) {
    const log: RecordEvent[] = [];
    const push = (
      type: RecordEventType,
      date: string,
      actor: RecordActor,
      summary: string,
    ) => log.push({ seq: log.length + 1, propertyId: p.id, type, date, actor, summary });

    if (p.submittedDate) {
      push('REGISTRATION_SUBMITTED', p.submittedDate, 'USER',
        `Registration application submitted for ${p.propertyId}.`);
    }
    if (p.registrationStatus === 'APPROVED' && p.reviewedDate) {
      push('REGISTRATION_APPROVED', p.reviewedDate, 'OFFICER',
        'Registration approved by authorized officer. Record finalized.');
    }
    if (p.registrationStatus === 'REJECTED' && p.reviewedDate) {
      push('REGISTRATION_REJECTED', p.reviewedDate, 'OFFICER',
        'Registration rejected by authorized officer.');
    }
    if (p.zkProofStatus === 'ZK_PROOF_VALID' && p.reviewedDate) {
      push('ZK_VERIFICATION_COMPLETED', p.reviewedDate, 'USER',
        'Eligibility verified via zero-knowledge proof. Property value remained private.');
    }
    history.set(p.id, log);
  }
}
seed();

// ── Read API ───────────────────────────────────────────────────────

/** Full event log for a property (oldest first). Treat as read-only. */
export function getHistory(propertyId: string): readonly RecordEvent[] {
  return history.get(propertyId) ?? [];
}

/** Latest status-changing event for a property, if any. */
export function getLatestStatusEvent(propertyId: string): RecordEvent | undefined {
  const log = getHistory(propertyId);
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const t = log[i].type;
    if (t === 'REGISTRATION_APPROVED' || t === 'REGISTRATION_REJECTED') return log[i];
  }
  return undefined;
}

/** Snapshot token for React useSyncExternalStore. */
export function getSnapshotVersion(): number {
  return snapshotVersion;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Authorized write API (append-only) ─────────────────────────────

/**
 * Officer action: approve a pending registration.
 * Appends a new finalized event; prior history is untouched.
 */
export function appendApproval(propertyId: string): void {
  appendEvent(propertyId, {
    type: 'REGISTRATION_APPROVED',
    date: new Date().toISOString().slice(0, 10),
    actor: 'OFFICER',
    summary: 'Registration approved by authorized officer. Record finalized.',
  });
}

/**
 * Officer action: reject a pending registration.
 * Appends a new event; prior history is untouched.
 */
export function appendRejection(propertyId: string): void {
  appendEvent(propertyId, {
    type: 'REGISTRATION_REJECTED',
    date: new Date().toISOString().slice(0, 10),
    actor: 'OFFICER',
    summary: 'Registration rejected by authorized officer.',
  });
}
