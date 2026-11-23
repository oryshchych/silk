import { z } from 'zod';

import { searchWarehouses } from '@store/core/np-directory';

import { getDb } from '@/lib/db';
import { json, limitedOrNull } from '@/lib/np-route';

const query = z.object({ city: z.string().min(1).max(64), q: z.string().max(60).default('') });

/** `GET /api/np/warehouses?city=<ref>&q=` — branches and lockers of one city. */
export async function GET(request: Request): Promise<Response> {
  const limited = await limitedOrNull(request);
  if (limited !== null) return limited;
  const { searchParams } = new URL(request.url);
  const parsed = query.safeParse({
    city: searchParams.get('city') ?? '',
    q: searchParams.get('q') ?? undefined,
  });
  if (!parsed.success) return json({ error: 'invalid_query' }, 400);
  return json({
    warehouses: await searchWarehouses(await getDb(), parsed.data.city, parsed.data.q),
  });
}
