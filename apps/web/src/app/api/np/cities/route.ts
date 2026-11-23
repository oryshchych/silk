import { searchSettlements } from '@store/core/np-directory';

import { getDb } from '@/lib/db';
import { json, limitedOrNull } from '@/lib/np-route';

/** `GET /api/np/cities?q=` — autocomplete from our own tables, not from the carrier API. */
export async function GET(request: Request): Promise<Response> {
  const limited = await limitedOrNull(request);
  if (limited !== null) return limited;
  const q = new URL(request.url).searchParams.get('q') ?? '';
  return json({ cities: await searchSettlements(await getDb(), q) });
}
