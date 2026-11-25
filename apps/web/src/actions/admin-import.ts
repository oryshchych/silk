'use server';

import { randomUUID } from 'node:crypto';

import { CsvError, parseCsv } from '@store/core/admin-csv';
import { ImportFileError } from '@store/core/admin-errors';
import { applyImport, planImport } from '@store/core/admin-import';
import { can } from '@store/core/auth-permissions';
import { z } from 'zod';

import { adminAction } from '@/lib/admin/bound-action';
import { catalogAction } from '@/lib/admin/catalog-action';

/**
 * The CSV arrives as text in a server action, so the body passes through `proxy.ts` and its 64 KB
 * limit (`proxyClientMaxBodySize`): that is about 250 rows. A bigger file is refused at the
 * limit with a clear message; the file is split. (A dedicated route like the photo upload would
 * lift it; queued.)
 */
/** BYTES, not characters: the proxy limit is on the request body, and a Cyrillic letter is two bytes. */
const MAX_CSV_BYTES = 56_000;
const schema = z.object({
  csv: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_CSV_BYTES, 'too large')
    .refine((value) => !value.includes('\u0000'), 'no NUL byte'),
});

function parse(csv: string) {
  try {
    return parseCsv(csv);
  } catch (error) {
    if (error instanceof CsvError) throw new ImportFileError(error.reason);
    throw error;
  }
}

/** Validates every row and writes nothing. */
export async function previewImportAction(input: unknown) {
  return await adminAction({
    permission: 'catalog.import',
    schema,
    input,
    run: async ({ tx, input: parsed, session, skipAudit }) => {
      const plan = await planImport(tx, parse(parsed.csv), {
        canPrice: can(session.role, 'catalog.price'),
        canSeeCost: can(session.role, 'catalog.cost.view'),
      });
      skipAudit();
      return { results: plan.results, ignoredColumns: plan.ignoredColumns };
    },
  });
}

/** Applies the valid rows (each in its own savepoint) and reports the rest by line. */
export async function commitImportAction(input: unknown) {
  return await catalogAction({
    permission: 'catalog.import',
    schema,
    input,
    op: async (tx, parsed, session) => {
      const plan = await planImport(tx, parse(parsed.csv), {
        canPrice: can(session.role, 'catalog.price'),
        canSeeCost: can(session.role, 'catalog.cost.view'),
      });
      return await applyImport(tx, plan, randomUUID());
    },
    // New products and renamed slugs: the proxy's redirect table and visible-slug set must see them.
    dropped: (data) => (data.created + data.updated > 0 ? { redirects: true, slugs: true } : {}),
  });
}
