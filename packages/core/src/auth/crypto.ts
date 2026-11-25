/**
 * Primitives of the admin authentication (ADR-19). Everything comes from `node:crypto`: no
 * dependency, nothing to keep patched.
 *
 *  - Passwords: argon2id, OWASP's minimum cost (19 MiB, 2 passes, 1 lane), a random salt per
 *    hash, the parameters stored with the hash so they can be raised later.
 *  - One server secret (`AUTH_SECRET`) is never used directly: each purpose derives its own key
 *    with HKDF, so a signature key can never decrypt a TOTP secret or the other way round.
 *  - TOTP secrets are encrypted with AES-256-GCM (a random nonce per value).
 */
import {
  argon2,
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const MIN_SECRET_LENGTH = 32;
const ARGON = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
const ARGON_PREFIX = 'argon2id$v1';

export type KeyPurpose = 'session' | 'totp';

/** A 32-byte key for one purpose. Throws (fails closed) when the server secret is missing or weak. */
export function deriveKey(secret: string | undefined, purpose: KeyPurpose): Buffer {
  if (secret === undefined || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`AUTH_SECRET must be set and at least ${String(MIN_SECRET_LENGTH)} characters`);
  }
  return Buffer.from(hkdfSync('sha256', secret, 'silk-auth', `silk:${purpose}`, 32));
}

function argon2Async(
  message: string,
  nonce: Buffer,
  params: { memory: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message, nonce, ...params }, (error, derived) => {
      if (error !== null) reject(error);
      else resolve(derived);
    });
  });
}

/** `argon2id$v1$m,t,p$salt$hash` (base64url parts). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2Async(password, salt, ARGON);
  const params = `${String(ARGON.memory)},${String(ARGON.passes)},${String(ARGON.parallelism)}`;
  return `${ARGON_PREFIX}$${params}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** A stored hash that never matches: spent on unknown accounts so timing does not tell them apart. */
const DUMMY_HASH_PROMISE = hashPassword(randomBytes(16).toString('hex'));

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const hash = stored ?? (await DUMMY_HASH_PROMISE);
  const parts = hash.split('$');
  const [name, version, params, salt, digest] = parts;
  if (
    parts.length !== 5 ||
    `${name ?? ''}$${version ?? ''}` !== ARGON_PREFIX ||
    params === undefined ||
    salt === undefined ||
    digest === undefined
  ) {
    return false;
  }
  const [memory, passes, parallelism] = params.split(',').map(Number);
  if (
    memory === undefined ||
    passes === undefined ||
    parallelism === undefined ||
    ![memory, passes, parallelism].every((value) => Number.isInteger(value) && value > 0)
  ) {
    return false;
  }
  const expected = Buffer.from(digest, 'base64url');
  const actual = await argon2Async(password, Buffer.from(salt, 'base64url'), {
    memory,
    passes,
    parallelism,
    tagLength: expected.length,
  });
  return stored !== null && actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** `v1.nonce.ciphertext+tag`, base64url. */
export function encryptSecret(plain: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `v1.${nonce.toString('base64url')}.${body.toString('base64url')}`;
}

/** Returns null for anything that is not an intact value made with this key (never throws). */
export function decryptSecret(stored: string, key: Buffer): string | null {
  const [version, nonce, body] = stored.split('.');
  if (version !== 'v1' || nonce === undefined || body === undefined) return null;
  try {
    const raw = Buffer.from(body, 'base64url');
    if (raw.length < 17) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - 16)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** SHA-256 hex: for values that are already high-entropy random (recovery codes). */
export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
