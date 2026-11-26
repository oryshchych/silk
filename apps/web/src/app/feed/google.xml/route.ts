import { getTranslations } from 'next-intl/server';

import { FEED_HEADERS, FEED_TYPES, openFeed, takeFeedSlot } from '../../../lib/product-feed';
import { getSiteUrl } from '../../../lib/site-url';

/** Product feed (google). Dynamic: the origin is a runtime value (ADR-10) and nothing is cached by Next. */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  // The slot is held for the whole stream: a feed is the heaviest read the site serves.
  const release = takeFeedSlot();
  if (release === null) {
    return new Response('Busy', { status: 503, headers: { 'Retry-After': '60' } });
  }
  try {
    const t = await getTranslations({ locale: 'uk', namespace: 'meta' });
    const stream = await openFeed(await getSiteUrl(), t('siteName'), 'google', release);
    return new Response(stream, {
      headers: { ...FEED_HEADERS, 'Content-Type': FEED_TYPES.google },
    });
  } catch (error: unknown) {
    release();
    throw error;
  }
}
