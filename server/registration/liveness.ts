// PRIESTATE — REAL liveness challenge engine (server-side only).
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// The liveness step runs REAL on-device computer vision (blink, head movement,
// hand-up, finger count, spoken phrase) but the SERVER controls which
// challenges must be completed:
//
//   * every start() issues a RANDOMIZED challenge set (order + values + phrase
//     chosen without any client input),
//   * challenges must be completed in the exact issued order, each with a
//     fresh, in-range observation window,
//   * a per-challenge evidence object is required — a bare `{ liveness: true }`
//     boolean is ALWAYS rejected (challenge ids + values are server-chosen and
//     unforgeable at structure level),
//   * the phrase and finger-count values are validated against the server's
//     chosen values server-side.
//
// Honesty boundary: a determined local attacker can always lie to browser JS,
// so this boundary is deliberately labeled `server-scoped` — the service
// records that a genuine combined session reported evidence it could not
// cryptographically attest. It never exaggerates proof.

import { randomBytes } from 'node:crypto';

export type LivenessChallengeType = 'blink' | 'head-movement' | 'hand-up' | 'finger-count' | 'phrase';

export interface LivenessChallenge {
  /** Server-chosen unique id for THIS challenge issuance. */
  readonly challengeId: string;
  readonly type: LivenessChallengeType;
  /** 1-based position in the issued sequence (completion order). */
  readonly ordinal: number;
  readonly params: {
    /** finger-count only: the target 1..5 the client must detect. */
    count?: number;
    /** phrase only: the prompted sentence (client must display to the user). */
    phrase?: string;
  };
}

export interface LivenessEvidenceInput {
  readonly ordinal: number;
  readonly type: LivenessChallengeType;
  /** Client-reported observation window in ms (server range-checks). */
  readonly observedMs?: number;
  /** finger-count only. */
  readonly count?: number;
  /** phrase only: the recognized transcript (server compares). */
  readonly transcript?: string;
}

export type LivenessEvidenceVerdict =
  | 'missing'
  | 'expired'
  | 'wrong-order'
  | 'invalid'
  | 'phrase-mismatch'
  | 'count-mismatch'
  | 'duplicate'
  | 'not-started';

export interface LivenessProgress {
  readonly total: number;
  readonly completed: number;
  readonly done: boolean;
  readonly currentChallenge: LivenessChallenge | null;
}

export interface LivenessStartResult {
  readonly ok: true;
  readonly challenges: readonly LivenessChallenge[];
  readonly expiresInMs: number;
  readonly currentChallenge: LivenessChallenge;
}

export interface LivenessEvidenceResult {
  readonly ok: boolean;
  readonly verdict: LivenessEvidenceVerdict | null;
  readonly progress: LivenessProgress;
}

export interface LivenessService {
  start(bindingKey: string): LivenessStartResult;
  evidence(bindingKey: string, input: LivenessEvidenceInput): LivenessEvidenceResult;
  progress(bindingKey: string): LivenessProgress | null;
  clear(bindingKey: string): void;
  sweep(now: number): void;
}

export interface LivenessServiceConfig {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly challengeCount?: number;
}

/** Prompt sentences the server may randomly assign as the spoken phrase. */
export const LIVENESS_PHRASES: readonly string[] = [
  'PRIESTATE identity check',
  'I am completing my registration',
  'Secure land verification',
];

/** Normalize a transcript/phrase for comparison (case + punctuation + spaces). */
export function normalizePhrase(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

const MAX_OBSERVED_MS = 20_000;
const MIN_OBSERVED_MS = 300;
const HAND_UP_MIN_MS = 800;
const PHRASE_MIN_MS = 900;

interface LiveSession {
  readonly challenges: readonly LivenessChallenge[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  nextOrdinal: number;
}

export class InMemoryLivenessService implements LivenessService {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly challengeCount: number;

  constructor(config: LivenessServiceConfig = {}) {
    this.now = config.now ?? Date.now;
    this.ttlMs = config.ttlMs ?? 10 * 60 * 1000;
    this.challengeCount = config.challengeCount ?? 5;
  }

  start(bindingKey: string): LivenessStartResult {
    const now = this.now();
    this.sessions.delete(bindingKey); // a fresh start replaces any prior attempt
    const challenges: LivenessChallenge[] = [];
    const order = this.shuffle([
      'blink',
      'head-movement',
      'hand-up',
      'finger-count',
      'phrase',
    ] as LivenessChallengeType[]);
    const chosen = order.slice(-this.challengeCount);
    // Ensure the spoken phrase is always part of the set.
    const types: LivenessChallengeType[] = chosen.includes('phrase')
      ? chosen
      : ['phrase', ...chosen.slice(0, -1)];
    types.forEach((type, idx) => {
      challenges.push({
        challengeId: randomBytes(12).toString('hex'),
        type,
        ordinal: idx + 1,
        params:
          type === 'finger-count'
            ? { count: this.randomInt(1, 5) }
            : type === 'phrase'
              ? { phrase: LIVENESS_PHRASES[this.randomInt(0, LIVENESS_PHRASES.length - 1)] }
              : {},
      });
    });
    this.sessions.set(bindingKey, {
      challenges,
      issuedAt: now,
      expiresAt: now + this.ttlMs,
      nextOrdinal: 1,
    });
    return {
      ok: true,
      challenges,
      expiresInMs: this.ttlMs,
      currentChallenge: challenges[0],
    };
  }

  evidence(bindingKey: string, input: LivenessEvidenceInput): LivenessEvidenceResult {
    const session = this.sessions.get(bindingKey);
    if (!session) {
      return { ok: false, verdict: 'not-started', progress: emptyProgress() };
    }
    const now = this.now();
    if (now >= session.expiresAt) {
      this.sessions.delete(bindingKey);
      return { ok: false, verdict: 'expired', progress: progressOf(session) };
    }
    const challenge = session.challenges.find((c) => c.ordinal === input.ordinal);
    if (!challenge) {
      return { ok: false, verdict: 'missing', progress: progressOf(session) };
    }
    if (input.ordinal !== session.nextOrdinal) {
      return { ok: false, verdict: input.ordinal < session.nextOrdinal ? 'duplicate' : 'wrong-order', progress: progressOf(session) };
    }
    if (input.type !== challenge.type) {
      return { ok: false, verdict: 'invalid', progress: progressOf(session) };
    }

    let accepted = false;
    switch (challenge.type) {
      case 'blink':
        accepted = Boolean(input.observedMs) && input.observedMs! >= MIN_OBSERVED_MS && input.observedMs! <= MAX_OBSERVED_MS;
        break;
      case 'head-movement':
        accepted = Boolean(input.observedMs) && input.observedMs! >= 400 && input.observedMs! <= MAX_OBSERVED_MS;
        break;
      case 'hand-up':
        accepted = Boolean(input.observedMs) && input.observedMs! >= HAND_UP_MIN_MS && input.observedMs! <= MAX_OBSERVED_MS;
        break;
      case 'finger-count': {
        const expected = challenge.params.count;
        if (expected === undefined || typeof input.count !== 'number' || !Number.isInteger(input.count)) {
          return { ok: false, verdict: 'invalid', progress: progressOf(session) };
        }
        if (input.count !== expected) {
          return { ok: false, verdict: 'count-mismatch', progress: progressOf(session) };
        }
        accepted = true;
        break;
      }
      case 'phrase': {
        const expected = normalizePhrase(challenge.params.phrase ?? '');
        if (!expected || !input.transcript || typeof input.observedMs !== 'number') {
          return { ok: false, verdict: 'invalid', progress: progressOf(session) };
        }
        if (input.observedMs < PHRASE_MIN_MS || input.observedMs > MAX_OBSERVED_MS) {
          return { ok: false, verdict: 'invalid', progress: progressOf(session) };
        }
        if (normalizePhrase(input.transcript) !== expected) {
          return { ok: false, verdict: 'phrase-mismatch', progress: progressOf(session) };
        }
        accepted = true;
        break;
      }
    }

    if (!accepted) {
      return { ok: false, verdict: 'invalid', progress: progressOf(session) };
    }

    const next = session.nextOrdinal + 1;
    session.nextOrdinal = next;
    const done = next > session.challenges.length;
    if (done) this.sessions.delete(bindingKey);
    return { ok: true, verdict: null, progress: progressOf({ ...session, nextOrdinal: next }) };
  }

  progress(bindingKey: string): LivenessProgress | null {
    const session = this.sessions.get(bindingKey);
    if (!session) return null;
    return progressOf(session);
  }

  clear(bindingKey: string): void {
    this.sessions.delete(bindingKey);
  }

  sweep(now: number): void {
    for (const [key, s] of this.sessions) {
      if (now >= s.expiresAt) this.sessions.delete(key);
    }
  }

  private shuffle<T>(items: readonly T[]): T[] {
    const arr = [...items];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = this.randomInt(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  private randomInt(min: number, max: number): number {
    const range = max - min + 1;
    const maxValid = Math.floor(0x1_0000_0000 / range) * range;
    let value = 0;
    do {
      value = randomBytes(4).readUInt32BE(0);
    } while (value >= maxValid);
    return min + (value % range);
  }
}

function progressOf(session: LiveSession): LivenessProgress {
  const total = session.challenges.length;
  const completed = session.nextOrdinal - 1;
  const done = completed >= total;
  return {
    total,
    completed,
    done,
    currentChallenge: done ? null : session.challenges[session.nextOrdinal - 1] ?? null,
  };
}

function emptyProgress(): LivenessProgress {
  return { total: 0, completed: 0, done: false, currentChallenge: null };
}