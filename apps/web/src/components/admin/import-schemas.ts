import { z } from 'zod';

/** What `POST /admin/upload/products-csv` answers, parsed on arrival (nothing is cast). */
const note = z.object({ column: z.string(), code: z.string() });
const importRow = z.object({
  line: z.number().int(),
  sku: z.string(),
  action: z.enum(['create', 'update', 'error']),
  errors: z.array(z.string()),
  notes: z.array(note),
});
export type ImportRow = z.output<typeof importRow>;

export const previewData = z.object({
  results: z.array(importRow),
  ignoredColumns: z.array(z.string()),
  absentColumns: z.array(z.string()),
});
export const commitData = z.object({
  results: z.array(importRow),
  created: z.number().int(),
  updated: z.number().int(),
  failed: z.number().int(),
});
const envelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);

export type RouteResult<T> = { ok: true; data: T } | { ok: false; code: string } | null;

/** Posts the raw CSV; `null` when the answer is not the route's JSON (a proxy error page, a dropped connection). */
export async function postCsv<S extends z.ZodType>(
  mode: 'preview' | 'commit',
  csv: string,
  schema: S,
): Promise<RouteResult<z.output<S>>> {
  try {
    const response = await fetch(`/admin/upload/products-csv?mode=${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      body: csv,
    });
    const body = envelope.safeParse(await response.json());
    if (!body.success) return null;
    if (!body.data.ok) return { ok: false, code: body.data.code };
    const data = schema.safeParse(body.data.data);
    return data.success ? { ok: true, data: data.data } : null;
  } catch {
    return null;
  }
}
