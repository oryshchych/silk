import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FAKE_ACCESS_KEY,
  FAKE_BUCKET,
  FAKE_SECRET_KEY,
  startFakeS3,
  type FakeS3,
} from '../test/fake-s3.ts';
import { assertSafeKey, createStorage, StorageError } from './storage.ts';

let fake: FakeS3;
beforeAll(async () => {
  fake = await startFakeS3();
});
afterAll(async () => {
  await fake.close();
});

const storage = (overrides: { secretAccessKey?: string; endpoint?: string } = {}) =>
  createStorage({
    endpoint: overrides.endpoint ?? fake.endpoint,
    bucket: FAKE_BUCKET,
    accessKeyId: FAKE_ACCESS_KEY,
    secretAccessKey: overrides.secretAccessKey ?? FAKE_SECRET_KEY,
  });

describe('storage over the S3 API', () => {
  it('stores Content-Disposition with the object when asked (a signed header, so the fake verifies it)', async () => {
    await storage().put('legal/a/b.pdf', Buffer.from('%PDF-1.7'), 'application/pdf', {
      contentDisposition: 'attachment; filename="document.pdf"',
    });
    const stored = fake.objects.get('legal/a/b.pdf');
    expect(stored?.contentType).toBe('application/pdf');
    expect(stored?.contentDisposition).toBe('attachment; filename="document.pdf"');
    expect(fake.rejected).toBe(0);
  });

  it('puts and deletes an object with a signature the fake verifies, setting type and cache headers', async () => {
    const body = Buffer.from('image bytes');
    await storage().put('products/p1/i1/full.webp', body, 'image/webp');
    const stored = fake.objects.get('products/p1/i1/full.webp');
    expect(stored?.body.equals(body)).toBe(true);
    expect(stored?.contentType).toBe('image/webp');
    expect(stored?.cacheControl).toContain('immutable');
    await storage().remove('products/p1/i1/full.webp');
    expect(fake.objects.has('products/p1/i1/full.webp')).toBe(false);
    // Deleting what is not there is not an error.
    await storage().remove('products/p1/i1/full.webp');
  });

  it('a wrong secret is refused by the fake (so the fake really verifies the signature)', async () => {
    const before = fake.rejected;
    await expect(
      storage({ secretAccessKey: 'wrong' }).put(
        'products/a/b/c.webp',
        Buffer.from('x'),
        'image/webp',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(fake.rejected).toBe(before + 1);
    expect(fake.objects.has('products/a/b/c.webp')).toBe(false);
  });

  it('refuses a key that could escape its folder or is not made of safe words', () => {
    for (const key of [
      '../x',
      'products/../x',
      '/products/x',
      'products//x',
      'Products/x',
      'products/x y',
      'products/x%2e%2e',
      '',
      'a'.repeat(400),
    ]) {
      expect(() => {
        assertSafeKey(key);
      }, key).toThrow(StorageError);
    }
    expect(() => {
      assertSafeKey('products/0b8f7c64-5d1e/full-1600.webp');
    }).not.toThrow();
  });

  it('refuses a plain-http endpoint unless it is loopback', () => {
    expect(() => storage({ endpoint: 'http://r2.example.com' })).toThrow(StorageError);
    expect(() => storage({ endpoint: 'https://acct.r2.cloudflarestorage.com' })).not.toThrow();
    expect(() => storage({ endpoint: 'http://127.0.0.1:9000' })).not.toThrow();
  });

  it('errors never carry credentials or the response body', async () => {
    try {
      await storage({ secretAccessKey: 'wrong' }).put(
        'products/a/b/d.webp',
        Buffer.from('x'),
        'image/webp',
      );
    } catch (error) {
      const text = String(error instanceof Error ? error.message : error);
      expect(text).not.toContain(FAKE_SECRET_KEY);
      expect(text).not.toContain(FAKE_ACCESS_KEY);
    }
  });
});
