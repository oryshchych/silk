import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decryptSecret,
  deriveKey,
  encryptSecret,
  hashPassword,
  recoveryHash,
  verifyPassword,
} from './crypto.ts';
import { PERMISSIONS, ROLES, can } from './permissions.ts';
import { readSessionToken, signSessionToken } from './session-token.ts';

const SECRET = 'x'.repeat(40);
const SID = '0b8f7c64-5d1e-4c53-9d0a-1f7d3a6a9b21';

describe('key derivation', () => {
  it('fails closed on a missing or short secret', () => {
    expect(() => deriveKey(undefined, 'session')).toThrow(/AUTH_SECRET/);
    expect(() => deriveKey('short', 'session')).toThrow(/AUTH_SECRET/);
  });

  it('gives each purpose its own key', () => {
    expect(deriveKey(SECRET, 'session').equals(deriveKey(SECRET, 'totp'))).toBe(false);
    expect(deriveKey(SECRET, 'recovery').equals(deriveKey(SECRET, 'totp'))).toBe(false);
    expect(deriveKey(SECRET, 'recovery').equals(deriveKey(SECRET, 'session'))).toBe(false);
    expect(deriveKey(SECRET, 'session').equals(deriveKey(SECRET, 'session'))).toBe(true);
  });
});

describe('password hashing', () => {
  it('verifies the right password and refuses a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^argon2id\$v1\$19456,2,1\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterz', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password here')).not.toBe(
      await hashPassword('same password here'),
    );
  });

  it('never matches a missing hash and refuses a malformed one without throwing', async () => {
    expect(await verifyPassword('anything', null)).toBe(false);
    for (const bad of [
      '',
      'plain',
      'argon2id$v1$x,y,z$a$b',
      'bcrypt$v1$1,1,1$a$b',
      'argon2id$v1$1,1,1$a',
    ]) {
      expect(await verifyPassword('anything', bad), bad).toBe(false);
    }
  });
});

describe('secret encryption', () => {
  const key = deriveKey(SECRET, 'totp');
  const owner = '0b8f7c64-5d1e-4c53-9d0a-1f7d3a6a9b21';

  it('round-trips and uses a fresh nonce each time', () => {
    const a = encryptSecret('JBSWY3DPEHPK3PXP', key, owner);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(encryptSecret('JBSWY3DPEHPK3PXP', key, owner));
    expect(decryptSecret(a, key, owner)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('is bound to its owner: a ciphertext copied into another account does not decrypt', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP', key, owner);
    expect(decryptSecret(stored, key, owner.replace(/^0/, '1'))).toBeNull();
  });

  it('returns null for another key, a flipped byte, the old format or garbage', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP', key, owner);
    expect(decryptSecret(stored, deriveKey(SECRET, 'session'), owner)).toBeNull();
    const parts = stored.split('.');
    const body = Buffer.from(parts[2] ?? '', 'base64url');
    body[0] = (body[0] ?? 0) ^ 1;
    expect(
      decryptSecret(`v2.${parts[1] ?? ''}.${body.toString('base64url')}`, key, owner),
    ).toBeNull();
    expect(decryptSecret(stored.replace(/^v2/, 'v1'), key, owner)).toBeNull();
    for (const bad of ['', 'v2', 'v3.a.b', randomBytes(8).toString('hex')]) {
      expect(decryptSecret(bad, key, owner), bad).toBeNull();
    }
  });
});

describe('recovery code hashing', () => {
  it('is keyed: the same code gives another hash under another key, and no bare hash', () => {
    const a = recoveryHash('abcde-fghij-12345-67890', deriveKey(SECRET, 'recovery'));
    const b = recoveryHash('abcde-fghij-12345-67890', deriveKey('y'.repeat(40), 'recovery'));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(createHash('sha256').update('abcde-fghij-12345-67890').digest('hex'));
  });
});

describe('the unknown-account path costs a password hash', () => {
  it('verifying against no stored hash takes about as long as against a real one', async () => {
    const real = await hashPassword('some-real-password-here');
    const time = async (stored: string | null): Promise<number> => {
      const samples: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const start = performance.now();
        await verifyPassword('wrong-password-attempt', stored);
        samples.push(performance.now() - start);
      }
      return samples.sort((x, y) => x - y)[1] ?? 0;
    };
    const known = await time(real);
    const unknown = await time(null);
    // Without the dummy hash the unknown path returns at once (a few microseconds).
    expect(unknown).toBeGreaterThan(known * 0.5);
  });
});

describe('session token', () => {
  const key = deriveKey(SECRET, 'session');
  const now = 1_700_000_000_000;

  it('reads back what it signed until it expires', () => {
    const token = signSessionToken(SID, now + 60_000, key);
    expect(readSessionToken(token, key, now)).toEqual({ sid: SID });
    expect(readSessionToken(token, key, now + 61_000)).toBeNull();
  });

  it('refuses a token signed with another key, a changed sid or expiry, and malformed input', () => {
    const token = signSessionToken(SID, now + 60_000, key);
    expect(readSessionToken(token, deriveKey(SECRET, 'totp'), now)).toBeNull();
    const [v, sid, exp, sig] = token.split('.');
    const other = '1b8f7c64-5d1e-4c53-9d0a-1f7d3a6a9b21';
    expect(readSessionToken(`${v ?? ''}.${other}.${exp ?? ''}.${sig ?? ''}`, key, now)).toBeNull();
    expect(
      readSessionToken(
        `${v ?? ''}.${sid ?? ''}.${String(Number(exp) + 9999)}.${sig ?? ''}`,
        key,
        now,
      ),
    ).toBeNull();
    for (const bad of [
      '',
      'v1',
      'v2.a.b.c',
      `${token}.extra`,
      'v1.not-a-uuid.1.x',
      'x'.repeat(500),
    ]) {
      expect(readSessionToken(bad, key, now), bad).toBeNull();
    }
  });
});

describe('permissions', () => {
  it('content cannot touch prices or cost, manager cannot edit the catalog, only owner manages users', () => {
    expect(can('content', 'catalog.price')).toBe(false);
    expect(can('content', 'catalog.cost.view')).toBe(false);
    expect(can('content', 'catalog.edit')).toBe(true);
    expect(can('manager', 'catalog.edit')).toBe(false);
    expect(can('manager', 'stock.adjust')).toBe(true);
    expect(can('admin', 'users.manage')).toBe(false);
    expect(can('owner', 'users.manage')).toBe(true);
  });

  it('names only known roles and every role may view the admin', () => {
    for (const roles of Object.values(PERMISSIONS)) {
      for (const role of roles) expect(ROLES).toContain(role);
    }
    for (const role of ROLES) expect(can(role, 'admin.view')).toBe(true);
  });
});
