import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyMonoSignature } from '../src/mono/signature.ts';

const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const body = new TextEncoder().encode('{"invoiceId":"x"}');
const good = sign('sha256', Buffer.from(body), pair.privateKey).toString('base64');

describe('verifyMonoSignature fails closed', () => {
  it('accepts exactly the signature made over these bytes', () => {
    expect(verifyMonoSignature(body, good, pem)).toBe(true);
  });

  it.each([
    ['null key', good, null],
    ['null signature', null, pem],
    ['empty signature', '', pem],
    ['malformed PEM', good, 'not a pem'],
    ['signature of the wrong length', Buffer.from('short').toString('base64'), pem],
    ['signature that is not base64', '%%%%', pem],
    [
      'an RSA key for an EC signature',
      good,
      generateKeyPairSync('rsa', { modulusLength: 2048 })
        .publicKey.export({ type: 'spki', format: 'pem' })
        .toString(),
    ],
  ])('%s is false, never an exception and never true', (_name, signature, key) => {
    expect(verifyMonoSignature(body, signature, key)).toBe(false);
  });

  it('one changed byte is false', () => {
    const changed = Uint8Array.from(body);
    changed[3] = (changed[3] ?? 0) ^ 1;
    expect(verifyMonoSignature(changed, good, pem)).toBe(false);
  });
});
