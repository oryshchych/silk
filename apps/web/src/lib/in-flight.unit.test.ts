import { describe, expect, it } from 'vitest';

import { createInFlight } from './in-flight';

describe('createInFlight', () => {
  it('N parallel acquirers: at most `global` get a slot, the rest are refused at once, and a release frees exactly one', () => {
    const slots = createInFlight({ global: 3, perKey: 3 });
    const got = Array.from({ length: 36 }, (_, i) => slots.acquire(`user-${String(i)}`));
    expect(got.filter((release) => release !== null)).toHaveLength(3);
    expect(slots.active()).toBe(3);
    got.find((release) => release !== null)?.();
    expect(slots.active()).toBe(2);
    expect(slots.acquire('someone-new')).not.toBeNull();
    expect(slots.acquire('another')).toBeNull();
  });

  it('one key may hold at most `perKey` slots even when the global room is free', () => {
    const slots = createInFlight({ global: 10, perKey: 1 });
    const first = slots.acquire('u');
    expect(first).not.toBeNull();
    expect(slots.acquire('u')).toBeNull();
    expect(slots.acquire('v')).not.toBeNull();
    first?.();
    expect(slots.acquire('u')).not.toBeNull();
  });

  it('releasing twice frees one slot only', () => {
    const slots = createInFlight({ global: 2, perKey: 2 });
    const release = slots.acquire('u');
    release?.();
    release?.();
    expect(slots.active()).toBe(0);
    slots.acquire('a');
    slots.acquire('b');
    expect(slots.acquire('c')).toBeNull();
  });
});
