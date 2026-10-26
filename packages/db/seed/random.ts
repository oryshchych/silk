/**
 * Детермінований PRNG (mulberry32). Seed однаковий на кожній машині й у
 * кожному прогоні — інакше «на staging товар без залишку» не відтворити
 * локально.
 */
export interface Rng {
  /** Ціле в [min, max] включно. */
  int: (min: number, max: number) => number;
  /** Елемент масиву. */
  pick: <T>(items: readonly T[]) => T;
  /** k різних елементів у вихідному порядку. */
  sample: <T>(items: readonly T[], k: number) => T[];
  chance: (p: number) => boolean;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick з порожнього масиву');
    return item;
  };

  const sample = <T>(items: readonly T[], k: number): T[] => {
    const indexes = items.map((_, i) => i);
    for (let i = indexes.length - 1; i > 0; i--) {
      const j = int(0, i);
      const a = indexes[i];
      const b = indexes[j];
      if (a === undefined || b === undefined) throw new Error('індекс поза межами');
      indexes[i] = b;
      indexes[j] = a;
    }
    return indexes
      .slice(0, k)
      .sort((x, y) => x - y)
      .map((i) => {
        const item = items[i];
        if (item === undefined) throw new Error('індекс поза межами');
        return item;
      });
  };

  return { int, pick, sample, chance: (p) => next() < p };
}
