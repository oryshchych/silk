import { getTranslations } from 'next-intl/server';

import { FEED_HEADERS, FEED_TYPES, openFeed, takeFeedSlot } from '../../../lib/product-feed';
import { getSiteUrl } from '../../../lib/site-url';

/** Product feed (google). Dynamic: the origin is a runtime value (ADR-10) and nothing is cached by Next. */
export const dynamic = 'force-dynamic';

const headers = { ...FEED_HEADERS, 'Content-Type': FEED_TYPES.google };

export async function GET(request: Request): Promise<Response> {
  // Next answers HEAD by calling this function and dropping the body WITHOUT cancelling the stream,
  // so a HEAD must never open one (it would keep its slot for good). Headers only, no database.
  if (request.method === 'HEAD') return new Response(null, { headers });
  const release = takeFeedSlot();
  if (release === null) {
    return new Response('Busy', {
      status: 503,
      headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
    });
  }
  // A client that goes away frees the slot at once.
  request.signal.addEventListener('abort', release, { once: true });
  try {
    const t = await getTranslations({ locale: 'uk', namespace: 'meta' });
    const stream = await openFeed(await getSiteUrl(), t('siteName'), 'google', release);
    return new Response(stream, { headers });
  } catch (error: unknown) {
    release();
    throw error;
  }
}
