import { describe, expect, it } from 'vitest';

import { createRng } from './random.ts';
import { assertSeedAllowed } from './seed.ts';
import { SCENARIOS, statusPath } from './scenarios.ts';

describe('assertSeedAllowed', () => {
  it('відмовляє в production', () => {
    expect(() => {
      assertSeedAllowed('production');
    }).toThrow(/production/);
  });

  it('дозволяє local і staging', () => {
    expect(() => {
      assertSeedAllowed('local');
      assertSeedAllowed('staging');
    }).not.toThrow();
  });
});

describe('createRng', () => {
  it('однаковий seed — однакова послідовність', () => {
    const a = createRng(42);
    const b = createRng(42);
    expect(Array.from({ length: 20 }, () => a.int(0, 1000))).toEqual(
      Array.from({ length: 20 }, () => b.int(0, 1000)),
    );
  });

  it('int тримається в межах включно', () => {
    const rng = createRng(1);
    const values = Array.from({ length: 2000 }, () => rng.int(3, 5));
    expect(new Set(values)).toEqual(new Set([3, 4, 5]));
  });

  it('sample повертає k різних елементів у вихідному порядку', () => {
    const picked = createRng(7).sample([1, 2, 3, 4, 5, 6], 3);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    expect([...picked].sort((x, y) => x - y)).toEqual(picked);
  });
});

describe('сценарії замовлень', () => {
  it('шлях статусу закінчується цільовим', () => {
    for (const s of SCENARIOS) expect(statusPath(s.status).at(-1)).toBe(s.status);
  });

  it('скасоване замовлення ніколи не проходило відправлення', () => {
    expect(statusPath('cancelled')).toEqual(['pending', 'cancelled']);
  });
});
