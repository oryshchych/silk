/**
 * Mono signs the exact bytes of the webhook body: `X-Sign` is a base64 ECDSA
 * (SHA-256, DER) signature, checked against the merchant public key. Any
 * re-serialisation of the JSON changes the bytes, so this runs on the raw
 * string before anything is parsed.
 */
import { createPublicKey, verify } from 'node:crypto';

/**
 * Fail closed: an absent key, an absent header or any malformed input is
 * `false`, never `true` (AGENTS.md security rules).
 */
export function verifyMonoSignature(
  rawBody: Uint8Array,
  signatureBase64: string | null,
  publicKeyPem: string | null,
): boolean {
  if (signatureBase64 === null || signatureBase64 === '' || publicKeyPem === null) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    return verify('sha256', rawBody, key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
