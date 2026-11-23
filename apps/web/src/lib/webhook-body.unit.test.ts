import { describe, expect, it } from 'vitest';

import { MAX_WEBHOOK_BYTES, readCappedBody } from './webhook-body';

const post = (body: BodyInit | null, headers: Record<string, string> = {}): Request =>
  new Request('https://shop.example/api/webhooks/mono', { method: 'POST', body, headers });

describe('readCappedBody', () => {
  it('returns the exact bytes, not decoded text', async () => {
    const raw = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]); // not valid UTF-8
    const result = await readCappedBody(post(raw), MAX_WEBHOOK_BYTES);
    expect(result).toEqual({ ok: true, bytes: raw });
  });

  it('refuses a declared length over the cap before reading anything', async () => {
    const request = post('x', { 'content-length': String(MAX_WEBHOOK_BYTES + 1) });
    expect(await readCappedBody(request, MAX_WEBHOOK_BYTES)).toEqual({ ok: false });
  });

  it('stops a body that lies about its length (a stream past the cap)', async () => {
    const big = 'x'.repeat(MAX_WEBHOOK_BYTES + 10);
    expect(await readCappedBody(post(big), MAX_WEBHOOK_BYTES)).toEqual({ ok: false });
  });

  it('accepts a body exactly at the cap and an empty body', async () => {
    const at = await readCappedBody(post('y'.repeat(MAX_WEBHOOK_BYTES)), MAX_WEBHOOK_BYTES);
    expect(at.ok && at.bytes.byteLength).toBe(MAX_WEBHOOK_BYTES);
    const empty = await readCappedBody(
      new Request('https://shop.example/x', { method: 'POST' }),
      MAX_WEBHOOK_BYTES,
    );
    expect(empty).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });
});
