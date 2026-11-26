/**
 * The safeguards of the import route, one by one, without a server: the checks that must come
 * BEFORE a body byte is read really do, and the single in-flight slot is released on every path
 * (success, a declared-too-large refusal, a body that overflows, a client that vanishes). Each
 * protection was removed in turn while writing this file and a test here failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  originOk: true,
  session: null as null | { kind: 'full'; session: { role: string; userId: string } },
  previews: 0,
  commits: 0,
};
vi.mock('@/lib/admin/bound-action', () => ({
  requestOriginOk: () => Promise.resolve(state.originOk),
}));
vi.mock('@/lib/admin/session', () => ({ currentSession: () => Promise.resolve(state.session) }));
vi.mock('@/lib/request-limits', () => ({
  checkRequestLimit: () => Promise.resolve({ allowed: true }),
}));
vi.mock('@/lib/admin/csv-import', () => ({
  previewImport: () => {
    state.previews += 1;
    return Promise.resolve({
      ok: true,
      data: { results: [], ignoredColumns: [], absentColumns: [] },
    });
  },
  commitImport: () => {
    state.commits += 1;
    return Promise.resolve({ ok: true, data: { results: [], created: 0, updated: 0, failed: 0 } });
  },
}));

// The unit project has no `@/` alias: the real helpers are handed over by relative path.
vi.mock('@/lib/in-flight', async () => await import('../../../../lib/in-flight'));
vi.mock('@/lib/rate-limit', async () => await import('../../../../lib/rate-limit'));
vi.mock('@/lib/read-capped', async () => await import('../../../../lib/read-capped'));

const { POST } = await import('./route');

let user = 0;
const owner = () => {
  user += 1;
  state.session = { kind: 'full', session: { role: 'owner', userId: `user-${String(user)}` } };
};

interface Body {
  request: Request;
  pulls: () => number;
}
function request(
  chunks: Uint8Array[] | 'forever' | 'error',
  headers: Record<string, string> = {},
  mode = 'preview',
): Body {
  let pulls = 0;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (chunks === 'forever') return new Promise(() => undefined);
        if (chunks === 'error') {
          controller.error(new Error('aborted'));
          return undefined;
        }
        const next = chunks[index];
        index += 1;
        if (next === undefined) controller.close();
        else controller.enqueue(next);
        return undefined;
      },
    },
    // Nothing is pulled until something reads: the count then says whether the route read.
    { highWaterMark: 0 },
  );
  return {
    request: new Request(`https://shop.example/admin/upload/products-csv?mode=${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv', ...headers },
      body: stream,
      duplex: 'half',
    } as RequestInit),
    pulls: () => pulls,
  };
}
const csv = new TextEncoder().encode('sku\nA\n');

beforeEach(() => {
  state.originOk = true;
  state.previews = 0;
  state.commits = 0;
  owner();
});

describe('nothing is read before the checks', () => {
  it('no session: 401, the body is not pulled', async () => {
    state.session = null;
    const body = request([csv]);
    expect((await POST(body.request)).status).toBe(401);
    expect(body.pulls()).toBe(0);
    expect(state.previews).toBe(0);
  });
  it('a foreign Origin: 403, the body is not pulled', async () => {
    state.originOk = false;
    const body = request([csv]);
    expect((await POST(body.request)).status).toBe(403);
    expect(body.pulls()).toBe(0);
  });
  it('a role without catalog.import: 403, the body is not pulled', async () => {
    for (const role of ['content', 'manager']) {
      user += 1;
      state.session = { kind: 'full', session: { role, userId: `user-${String(user)}` } };
      const body = request([csv]);
      expect((await POST(body.request)).status).toBe(403);
      expect(body.pulls()).toBe(0);
    }
    expect(state.previews).toBe(0);
  });
  it('another content type: 415, the body is not pulled', async () => {
    const body = request([csv], { 'Content-Type': 'application/json' });
    expect((await POST(body.request)).status).toBe(415);
    expect(body.pulls()).toBe(0);
  });
  it('an unknown mode: 400, the body is not pulled', async () => {
    const body = request([csv], {}, 'wipe');
    expect((await POST(body.request)).status).toBe(400);
    expect(body.pulls()).toBe(0);
  });
});

describe('size', () => {
  it('a declared length over 2 MB is refused 413 before the slot and the body, with Connection: close', async () => {
    const body = request([csv], { 'Content-Length': String(3 * 1024 * 1024) });
    const response = await POST(body.request);
    expect(response.status).toBe(413);
    expect(response.headers.get('connection')).toBe('close');
    expect(body.pulls()).toBe(0);
  });
  it('a body of unknown length is cut at 2 MB (413) and closes the connection', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    const body = request([chunk, chunk, chunk]);
    const response = await POST(body.request);
    expect(response.status).toBe(413);
    expect(response.headers.get('connection')).toBe('close');
  });
});

describe('the single in-flight slot', () => {
  it('is released after a success, a refusal, an overflow and a vanished client', async () => {
    const ok = await POST(request([csv]).request);
    expect(ok.status).toBe(200);
    const big = new Uint8Array(1024 * 1024).fill(97);
    expect((await POST(request([big, big, big]).request)).status).toBe(413);
    expect((await POST(request('error').request)).status).toBe(400);
    // After all of them the slot is free: a normal import is admitted at once.
    expect((await POST(request([csv]).request)).status).toBe(200);
  });
  it('while an upload is in flight the next one is turned away 429 BUSY, then admitted', async () => {
    let finish: () => void = () => undefined;
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(csv);
        finish = () => {
          controller.close();
        };
      },
    });
    const first = POST(
      new Request('https://shop.example/admin/upload/products-csv?mode=preview', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: slow,
        duplex: 'half',
      } as RequestInit),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A second request by ANOTHER user is turned away too: the slot is global.
    owner();
    const busy = await POST(request([csv]).request);
    expect(busy.status).toBe(429);
    expect(((await busy.json()) as { code: string }).code).toBe('BUSY');
    finish();
    await first;
    expect((await POST(request([csv]).request)).status).toBe(200);
  });
});

describe('what runs after the checks', () => {
  it('a UTF-8 file reaches the preview or the commit by its mode; invalid UTF-8 is 422 and runs nothing', async () => {
    expect((await POST(request([csv], {}, 'preview').request)).status).toBe(200);
    expect((await POST(request([csv], {}, 'commit').request)).status).toBe(200);
    expect([state.previews, state.commits]).toEqual([1, 1]);
    const bad = await POST(request([new Uint8Array([0x73, 0xff, 0xfe])]).request);
    expect(bad.status).toBe(422);
    expect([state.previews, state.commits]).toEqual([1, 1]);
  });
  it('every answer is private, no-store and noindex', async () => {
    for (const response of [
      await POST(request([csv]).request),
      await POST(request([csv], { 'Content-Type': 'text/html' }).request),
    ]) {
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-robots-tag')).toContain('noindex');
    }
  });
});
