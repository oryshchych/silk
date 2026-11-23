import { NextResponse } from 'next/server';

import { checkRequestLimit, limiters } from './request-limits';

const HEADERS = { 'Cache-Control': 'no-store' } as const;

/** Directory lookups are per-keystroke database queries: limited per client and never cached. */
export async function limitedOrNull(request: Request): Promise<NextResponse | null> {
  const verdict = await checkRequestLimit(limiters.np, request);
  if (verdict.allowed) return null;
  return new NextResponse('Too many requests', {
    status: 429,
    headers: { ...HEADERS, 'Retry-After': String(verdict.retryAfterSeconds) },
  });
}

export const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, { status, headers: HEADERS });
