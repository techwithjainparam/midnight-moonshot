// PRIESTATE — Tiny random-token helper (Web Crypto).
//
// Generates a cryptographically random hex token in the browser without a
// third-party dependency. Works in modern browsers and (for tests) under
// Node via globalThis.crypto.

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function randomHex(lengthBytes: number): string {
  const bytes = new Uint8Array(lengthBytes);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    // Deterministic fallback only when Web Crypto is unavailable.
    for (let i = 0; i < lengthBytes; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytesToHex(bytes);
}
