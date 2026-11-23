/** HTTP helpers shared by the smoke scripts: server actions, cookies, variant discovery. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Jar = Map<string, string>;

export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Server action ids by exported name, from the build's server-reference manifest. */
export function actionIds(buildRoot: string): Record<string, string> {
  const manifest = JSON.parse(
    readFileSync(join(buildRoot, 'apps/web/.next/server/server-reference-manifest.json'), 'utf8'),
  ) as { node: Record<string, { exportedName: string }> };
  return Object.fromEntries(
    Object.entries(manifest.node).map(([id, entry]) => [entry.exportedName, id]),
  );
}

export function absorb(jar: Jar, response: Response): void {
  for (const line of response.headers.getSetCookie()) {
    const [pair = ''] = line.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

export const cookieHeader = (jar: Jar): string =>
  [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

/** Well-stocked variant ids, read from the first product pages of the home page. */
export async function plentyVariants(
  base: string,
): Promise<{ ids: string[]; productPath: string }> {
  const home = await (await fetch(base + '/')).text();
  const slugs = [
    ...new Set([...home.matchAll(/href="(\/product\/[^"]+)"/g)].map((m) => m[1] ?? '')),
  ];
  const pattern = new RegExp(
    `\\\\"id\\\\":\\\\"(${UUID})\\\\",\\\\"sizeLabel\\\\":[^}]*?\\\\"available\\\\":(true|false),\\\\"lastUnits\\\\":(true|false)`,
    'g',
  );
  const found: string[] = [];
  for (const path of slugs.slice(0, 8)) {
    const html = await (await fetch(base + path)).text();
    for (const match of html.matchAll(pattern)) {
      if (match[2] === 'true' && match[3] === 'false') found.push(match[1] ?? '');
    }
  }
  return { ids: found, productPath: slugs[0] ?? '/' };
}
