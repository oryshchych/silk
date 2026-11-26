import { randomUUID } from 'node:crypto';

import { CSV_LIMITS, CsvError, parseCsv } from '@store/core/admin-csv';
import { ImportFileError } from '@store/core/admin-errors';
import { applyImport, planImport } from '@store/core/admin-import';
import { can } from '@store/core/auth-permissions';
import { z } from 'zod';

import { adminAction } from './bound-action';
import { catalogAction } from './catalog-action';

/**
 * The CSV import, previewed and committed. Called by `POST /admin/upload/products-csv`, which has
 * already read the body under its own caps; every check of `adminAction` (Origin, session, the
 * `catalog.import` permission, the per-user limit, validation, audit) still runs here, so this
 * module is as safe as a server action on its own.
 */
const schema = z.object({
  csv: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= CSV_LIMITS.maxBytes, 'too large')
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
export async function previewImport(csv: string) {
  return await adminAction({
    permission: 'catalog.import',
    schema,
    input: { csv },
    run: async ({ tx, input, session, skipAudit }) => {
      const plan = await planImport(tx, parse(input.csv), {
        canPrice: can(session.role, 'catalog.price'),
        canSeeCost: can(session.role, 'catalog.cost.view'),
      });
      skipAudit();
      return {
        results: plan.results,
        ignoredColumns: plan.ignoredColumns,
        absentColumns: plan.absentColumns,
      };
    },
  });
}

/** Applies the valid rows (each in its own savepoint) and reports the rest by line. */
export async function commitImport(csv: string) {
  return await catalogAction({
    permission: 'catalog.import',
    schema,
    input: { csv },
    op: async (tx, input, session) => {
      const plan = await planImport(tx, parse(input.csv), {
        canPrice: can(session.role, 'catalog.price'),
        canSeeCost: can(session.role, 'catalog.cost.view'),
      });
      return await applyImport(tx, plan, randomUUID());
    },
    // New products and renamed slugs: the proxy's redirect table and visible-slug set must see them.
    dropped: (data) => (data.created + data.updated > 0 ? { redirects: true, slugs: true } : {}),
  });
}
