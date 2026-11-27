# Product views (phase 10)

The data behind the "viewed but not bought" report. Deliberately small: no funnel, nothing called conversion.

## Write path

1. The product page stays static (ISR, shared cache). After it has loaded, the tiny client component
   `ProductViewBeacon` sends `navigator.sendBeacon('/api/pv', {"productId": "<uuid>"})`. It sends nothing else.
2. `POST /api/pv` (`app/api/pv/route.ts`) is public, so it is bounded:
   - a same-site `Origin` (host compared) and no `Sec-Fetch-Site: cross-site`: a page on another site cannot make a
     visitor count. Not a trust boundary: a script sets any header, and the route trusts `X-Forwarded-Host` before
     `Host`, so the reverse proxy in front of the app must overwrite it;
   - a body of at most 256 bytes: a declared length over it is refused before anything is read (413, connection
     closed), the read itself is capped. The framework's own 64 KB body buffer (`proxyClientMaxBodySize`) applies
     before the route and the proxy matcher includes `/api/pv` on purpose (basic auth on staging); a stalled slow body
     therefore holds a socket until Node's timeout, which the edge (Cloudflare) cuts first in production;
   - a per-client limit (60 requests a minute), a per-client DAILY cap (300 rows) and a TOTAL cap (300 rows a minute
     over all clients). Only a row that was really written spends the daily and total caps: a request for a missing
     or hidden product, or a repeat, costs neither, and a row a cap refuses is undone with its transaction. Past a cap
     the view is dropped silently;
   - the write has its own 500 ms statement timeout, so a hung database cannot hold the storefront's connection.
3. Any well-formed request about any product gets the same empty `204`; a malformed, foreign-origin, oversized or too
   frequent one gets 400, 403, 413 or 429. So the answer says nothing about whether the product exists or the view was
   written.
4. `recordProductView` (`packages/core/src/product-views`) writes one row for a product the storefront shows
   (`visibleProduct`); a repeat is a no-op by the unique index (product, session hash, UTC day).

## What a row holds

Product id, an opaque session hash, the UTC day. The hash is HMAC-SHA256, under a key derived from `AUTH_SECRET`
(HKDF, purpose `product-view`), of the UTC day and the client address. The user agent is NOT in it (the client
controls it: a rotating agent would turn one visitor into many rows). It cannot be reversed without the secret, it
differs every day (a visitor cannot be followed across days), and no address, agent or cookie is stored. With no
`AUTH_SECRET` configured nothing is stored. Whether such a hash is personal data is a question for the lawyer (owner
queue Q88); the privacy text of phase 8 should say that anonymous product view counts are kept for 90 days.

## Policy

- Do not track: the beacon sends nothing when the browser says `doNotTrack`. A prefetched page does not run the
  component (an effect runs only in a real visit). Bots that run JavaScript are counted, bounded by the caps and the
  hash (one row per address per product per day).
- Forgery: the count is a rough number of sessions per day, not an audit. Someone with many addresses can add rows up
  to the caps; the report lists products to look at and divides nothing by anything.
- Retention against the report window: rows are kept 90 days, so the "viewed but not bought" report is complete for
  periods inside the last 90 days only; an older period shows what remains. The report carries a note about it.
- Limiter state is per application instance (in memory, 20 000 keys, fail closed): with several instances the caps
  multiply, and a botnet of 20 000 distinct addresses can stop NEW visitors from being counted for a minute (the
  shared limiter is phase 12).

## Retention job

`views.cleanup` (worker, daily 05:00 Kyiv time) removes rows older than 90 days by the database's UTC date, in
batches of 5 000 rows, each batch its own short transaction, at most 200 batches a run (the next run continues). The
worker is not deployed yet (Q31), so until it is, the table only grows: at most 300 rows a minute, 432 000 a day in
the worst case.
