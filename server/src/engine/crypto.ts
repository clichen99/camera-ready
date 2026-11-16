// Randomness and hashing via Web Crypto (available in both Workers and Node).
import { SLIP_ALPHABET, SLIP_LENGTH } from "../../../shared/protocol";

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function randomId(): string {
  return [...randomBytes(8)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** 13 Crockford base32 characters = 65 bits of randomness. */
export function newSlipCode(): string {
  const bytes = randomBytes(9); // 72 bits, we use 65
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < SLIP_LENGTH; i++) {
    out += SLIP_ALPHABET[Number(bits & 31n)];
    bits >>= 5n;
  }
  return out;
}

/** 32 random bytes, base64url (43 chars). */
export function newToken(): string {
  const b = randomBytes(32);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (for the admin secret). */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
