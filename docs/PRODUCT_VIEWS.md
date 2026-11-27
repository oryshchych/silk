# Product views (phase 10)

The data behind the "viewed but not bought" report. Deliberately small: no funnel, nothing called conversion.

## Write path

1. The product page stays static (ISR, shared cache). After it has loaded, the tiny client component
   `ProductViewBeacon` sends `navigator.sendBeacon('/api/pv', {"productId": "<uuid>"})`. It sends nothing
   else and nothing at all when the browser says "do not track".
2. `POST /api/pv` (`app/api/pv/route.ts`) is public, so it is bounded: a same-site `Origin` (a page on another
   site cannot make a visitor count; not a trust boundary, a script can set headers), a body of at most 256
   bytes read with a cap, a per-client limit (60 a minute), and a TOTAL cap of 300 rows stored a minute over all
   clients (past it a view is dropped silently, so a botnet cannot fill the table). A well-formed request always
   gets an empty `204`, so the answer says nothing about whether the product exists or the view was written.
3. `recordProductView` (`packages/core/src/product-views`) writes one row for a product the storefront shows
   (`visibleProduct`); a repeat is a no-op by the unique index (product, session hash, UTC day).

## What a row holds

Product id, an opaque session hash, the UTC day. The hash is HMAC-SHA256, under the server secret, of the UTC
day, the client address and the user agent: it cannot be reversed without the secret, it differs every day (a
visitor cannot be followed across days), and no address, agent or cookie is stored. Whether such a hash is
personal data is a question for the lawyer (owner queue Q88); the privacy text of phase 8 should say that
anonymous product view counts are kept for 90 days.

## Forgery and limits

The count is a rough number of sessions per day, not an audit: someone who rotates address and agent can add
rows, up to the per-client and total caps. The report lists products to look at; it divides nothing by anything.

## Retention

`views.cleanup` (worker, daily 05:00 Kyiv time) removes rows older than 90 days by the database's UTC date.
The worker is not deployed yet (Q31), so until it is, the table only grows: at most 300 rows a minute,
432 000 a day in the worst case.
