/**
 * Minimal ULID (Crockford base32, 26 chars, time-ordered) for `runs.id` /
 * `items_run.id` (TRD: ids must be sortable by creation). No dependency —
 * 10 chars of millisecond timestamp + 16 chars of crypto randomness.
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let random = "";
  for (const byte of rnd) random += ALPHABET.charAt(byte % 32);
  return time + random;
}
