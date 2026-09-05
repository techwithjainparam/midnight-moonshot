// PRIESTATE — Client IP resolution for rate limiting behind a trusted edge.
//
// ⚠️ SERVER-SIDE ONLY. Never bundled into the browser.
//
// Rate limiters key on the caller's IP. Bare `req.socket.remoteAddress` gives
// the reverse-proxy's address once a load balancer sits in front, which would
// collapse every caller into ONE shared bucket. This module lets the server
// read a single level of `X-Forwarded-For` appended by the trusted edge.
//
// Why the RIGHTMOST entry? A trusted edge APPENDS the real client address as
// the LAST hop it saw. Everything to the LEFT of it was supplied by the client
// itself and is attacker-controlled, so we deliberately ignore it. An attacker
// cannot forge the rightmost entry because their spoofed header is what the
// edge prepends, not appends. (This is only valid behind a single edge hop —
// the supported deployment topology for this service.)

export interface ClientIpSource {
  /** `req.socket.remoteAddress` — the immediate network peer. */
  readonly socketAddress: string;
  /** Raw `X-Forwarded-For` value (string, array, or absent). */
  readonly forwardedFor?: string | readonly string[];
}

/**
 * Resolve the client IP for rate limiting.
 *
 * - `trustProxy === false` (default): return the socket peer address and
 *   ignore `X-Forwarded-For` entirely — do not trust client headers.
 * - `trustProxy === true`: return the RIGHTMOST `X-Forwarded-For` entry when
 *   present (the edge-appended real caller), else fall back to the socket
 *   address. Malformed or empty values never win over the socket address.
 */
export function resolveClientIp(source: ClientIpSource, trustProxy: boolean): string {
  if (!trustProxy) return source.socketAddress;

  const raw = Array.isArray(source.forwardedFor)
    ? source.forwardedFor.join(',')
    : source.forwardedFor;

  if (typeof raw !== 'string' || raw.trim() === '') {
    return source.socketAddress;
  }

  const entries = raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  if (entries.length === 0) return source.socketAddress;
  return entries[entries.length - 1];
}