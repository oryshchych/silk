import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import en from '../../messages/en.json';
import uk from '../../messages/uk.json';
import { en as lastEn, uk as lastUk } from './last-resort-messages';

const tree = z.record(z.string(), z.record(z.string(), z.unknown()));

function expectSubset(small: unknown, full: unknown): void {
  const smallTree = tree.parse(small);
  const fullTree = tree.parse(full);
  for (const [group, keys] of Object.entries(smallTree)) {
    for (const [key, value] of Object.entries(keys)) {
      expect(value, `${group}.${key}`).toBe(fullTree[group]?.[key]);
    }
  }
}

describe('last-resort messages', () => {
  it('equal the message files for every key they carry', () => {
    expectSubset(lastUk, uk);
    expectSubset(lastEn, en);
  });
});
