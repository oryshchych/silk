import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PERMISSIONS, type Permission } from './permissions.ts';

const doc = readFileSync(new URL('../../../../docs/SECURITY.md', import.meta.url), 'utf8');

function documented(): Map<string, string[]> {
  const block = /<!-- permissions:start -->([\s\S]*?)<!-- permissions:end -->/.exec(doc)?.[1] ?? '';
  const rows = new Map<string, string[]>();
  for (const line of block.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const name = /^`([a-z.]+)`$/.exec(cells[1] ?? '')?.[1];
    if (name !== undefined)
      rows.set(
        name,
        (cells[2] ?? '').split(',').map((role) => role.trim()),
      );
  }
  return rows;
}

describe('docs/SECURITY.md matches the code', () => {
  it('lists every permission with exactly the roles the code grants', () => {
    const rows = documented();
    const names = Object.keys(PERMISSIONS) as Permission[];
    expect([...rows.keys()].sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(rows.get(name), name).toEqual([...PERMISSIONS[name]]);
    }
  });
});
