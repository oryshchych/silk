# MARKETING.md

Phase 11 marketing features: what each does, who it may mail, and where the consent lives. English technical text.

## Abandoned cart reminder

- **Who:** a signed-in customer with an active, confirmed `newsletter_subscribers` row AND `customers.accepts_marketing`.
  A guest cart has no address (checkout asks for it only at the end) and is never mailed. Capturing an address earlier
  would need consent copy and a schema change: owner queue Q89.
- **When:** the cart changed at least 2 hours and at most 72 hours ago, has items, was not converted, and the customer
  placed no order (by account or by address) since the cart last changed.
- **Per customer:** at most one cart reminder per customer per 7 days (`CUSTOMER_REMINDER_CAP_DAYS`), whatever number of carts
  they left; the newest cart wins. Claims are serialised by one advisory lock so two workers cannot race the cap, and the
  candidate carts are locked with SKIP LOCKED: a cart held by an open checkout waits for the next 15-minute run and never
  stalls the batch.
- **Once:** `carts.abandoned_email_sent_at` is set by one conditional UPDATE and never cleared; the outbox row has the dedup
  key `cart-reminder:<cart id>`; the provider call carries an idempotency key. Two workers cannot claim one cart.
- **At send time** the handler re-reads the facts and sends nothing when any holds: converted, an order since the cart's last
  activity (the instant recorded in the queue row, because the claim itself bumps `updated_at` through the touch trigger; an
  order committed after the claim counts), the cart changed since the claim (`carts.version` recorded in the queue row), the
  claim older than 24 hours (`REMINDER_SEND_WINDOW_HOURS`, a stuck relay), consent withdrawn, goods sold out. The quantity shown
  is capped at the stock. The mail shows no price. It carries the unsubscribe link.
- **Job** `carts.remind-abandoned` every 15 minutes (Kyiv zone), topic `email.cart-reminder` (queue in `OUTBOX_TOPICS`).
- **Unsubscribe link:** `/unsubscribe/marketing?t=<subscriber id>.<HMAC>` (key derived from `AUTH_SECRET`, purpose
  `marketing-unsubscribe`). Opening it changes nothing; the button POSTs. It sets `newsletter_subscribers.unsubscribed_at`
  and clears the customer flag, with one audit row naming the subscriber id (never the address).
- Not built: a `List-Unsubscribe` and `List-Unsubscribe-Post` header (the sender interface carries no custom headers yet):
  owner queue Q90.
- Mixed-case addresses: `customers.email` is lower-cased by a CHECK, and the claim joins `newsletter_subscribers` on it;
  every writer of a subscriber row must lower-case the address (slice C), or that row never matches (a safe failure).

## Newsletter (double opt-in)

- **Subscribe:** `/newsletter` (footer link), a form with an email field and an UNTICKED consent box whose wording is
  versioned (`NEWSLETTER_CONSENT_VERSION`, `messages/*.json` `newsletter.consent`). A request creates or re-opens a PENDING
  `newsletter_subscribers` row (`confirmed_at` and `unsubscribed_at` empty) and may queue `email.newsletter-confirm`. It
  stores no consent.
- **The link belongs to one request generation.** `request_nonce` (migration 0024) is signed into the link and compared in
  the confirm UPDATE together with `unsubscribed_at IS NULL`. Every confirmation, every unsubscribe (the mailed link and the
  account toggle) and every re-open after an unsubscribe rotates it, so a consumed link, a link from before an unsubscribe
  and a link of an earlier request are dead. A pending repeat keeps the generation (the mail in the inbox stays valid).
- **Same answer, same work for everyone:** new, pending, subscribed and previously unsubscribed addresses all get "check
  your inbox", and the same statements run in every state (only the values written and the gated outbox and audit inserts
  differ). One confirmation mail per pending subscriber per hour (`confirm_mail_queued_at`), except that a re-open after an
  unsubscribe sends at once (a new generation). A hidden honeypot is answered as a success and stores nothing.
- **Limits** (in process memory, per instance; the shared limiter is phase 12): 5 requests per 10 minutes per client, 300
  per minute in total, 60 per 10 minutes per mail domain, 3 per hour per canonical mailbox (plus tag dropped). Every
  attempt is metered before validation. Next step before real volume: Turnstile on the form, and a warning log when the
  global cap passes half.
- **Confirm:** `/newsletter/confirm?t=<id>.<nonce>.<expiry>.<HMAC>` (key purpose `newsletter-confirm`, valid 48 hours, the
  database clock decides). Opening the link changes nothing; the button POSTs.
- **The newsletter consent covers the newsletter only.** Confirming never switches on `customers.accepts_marketing`, which
  gates the abandoned-cart reminder (owner queue Q91 has the alternative). Withdrawing by the unsubscribe link switches the
  flag off too; the account toggle manages both.
- **Consent evidence:** `confirmed_at` is the consent time, `unsubscribed_at` its end; audit rows `marketing.subscription_requested`
  (only when a mail is queued or the state changes) and `marketing.subscription_confirmed` carry the wording version, the
  source and the language, never the address or an IP.
- One spelling per mailbox: addresses are lower-cased once and the schema forbids upper case (`newsletter_email_lower`).
- Not built: sending campaigns (no bulk mailer), a subscribers screen in the admin, bounce handling.

## Banners (home page)

- **Admin:** `/admin/marketing/banners` (`banners.edit`: owner, admin, content). A banner has text and a button label in both
  languages, alt text in both languages, a link that is a PATH on this shop (an external address is refused by the
  schema and by a CHECK), a display period in Kyiv time, an order, and TWO pictures uploaded separately (a wide desktop one
  and a tall mobile one) through `POST /admin/upload/banner-image` (same hardening as the product photo route: session and
  role before the body, size cap while streaming, in-flight slots, type from the bytes, metadata stripped). The pictures
  are stored as AVIF and WebP renditions under `banners/<banner id>/<image id>/`; a replaced picture's files are removed.
- **A banner is born inactive** and can be switched on only when complete: both pictures and alt text in both languages
  (the action checks it under a per-banner lock, and the CHECK `banners_active_complete` backs it).
- **Cache-safe public rendering:** banners are read and rendered on the HOME page only, which is rendered per request and
  never stored as a page. The read takes nothing about the visitor, its key is `['banners', locale]`, the period is decided
  by Postgres' `now()` when the cache fills, a 60 second TTL moves it over a boundary and an admin change expires the tag
  `banners` at once after the commit (`updateTag` in the actions, an immediate expiry in the upload route), so the very next
  request after a save or a delete reads fresh data. The period boundary itself (a banner that starts or ends by the clock) is
  picked up within about 60 seconds of the next request, per web process: with several replicas each has its own cache. The ISR pages (product, category) never import banners (pinned by `banners.unit.test.ts`),
  so no banner change can make a shared page differ between visitors or go stale.
- **Rendering:** one `<picture>` per banner, mobile sources under `(max-width: 767px)`, AVIF, WebP and the original, the box
  reserved from the stored dimensions, the first banner the LCP candidate and the rest lazy.
- Not built: banner positions other than `home_hero`, per-banner statistics, scheduling per locale. A deleted banner's files are removed after the
  commit, as are a replaced picture's (best effort; a failure is logged and leaves an orphan that no sweep covers yet).
- **Deploy note:** migrations 0025 and 0026 are forward-only and drop what they must (0025 clears every picture reference and
  switches every old row off; 0026 clears a bad picture whole, a bad link, and switches off an incomplete banner). Snapshot the
  `banners` table before applying them on staging or production.

## Blog (posts and tags)

- **Admin:** `/admin/marketing/blog` (`blog.edit`: owner, admin, content). A post has titles, excerpt, a Markdown body, meta text
  in both languages, an author name (empty: the shop), up to ten tags (lower-case words joined by hyphens) and a publication
  time. Buttons: Save, Publish now, Back to draft, Delete. The address (slug) is set once at creation: it is a public URL.
  Migration 0028 adds the slug and tag CHECKs, a GIN index on tags and `NOT NULL DEFAULT '{}'` for tags.
- **Public:** `/blog` (index, `?page=`), `/blog/tag/<tag>` and `/blog/<slug>`, in both languages. A post is public when its
  publication time has passed BY THE DATABASE CLOCK and it has a body in the language asked, so a post written in one language
  appears in that language only, with a self canonical and NO hreflang pair (a pair exists only when both languages have a body).
- **Indexing and structured data:** the post page is ISR (`revalidate = 300`), indexable, with a canonical, `Article` and
  `BreadcrumbList` JSON-LD (headline, dates, language, author as a person or the shop, tags as keywords). No image is declared:
  posts have no cover picture yet (owner queue Q94). The index is indexed on its first page only; tag pages are followed, not indexed.
  Posts are in `pages.xml` of the sitemap (per language, with the pair only when both exist); the footer links to the blog.
- **Cache-safe and bounded:** the pages read nothing about the visitor (pinned by `blog.unit.test.ts`), so every visitor gets the
  same bytes. Cache keys are a locale, a word the proxy gate already checked and a clamped page. The proxy answers an unknown
  address, a draft, a post without a body in this language and a word of the wrong shape with the shared 404 BEFORE the route
  (`knownBlogPages`, refreshed once a minute and on every admin change), so nothing a client types can become a page cache
  entry. Admin changes expire the `blog` and `blog:<slug>` tags at once (`updateTag`).
- **Safe text:** the body is stored as Markdown and rendered and sanitised when read (allowlist of tags, vetted links, no script or
  handler); the audit row of a change never holds the text (a body or an excerpt is recorded as "changed").
- **Size ceiling:** the whole text of a post travels in ONE request that the proxy caps at 64 KB, so the form counts the serialised
  bytes of all its text fields (both languages together, a Cyrillic character is two bytes: about 28 000 characters in all) and
  refuses to save above `POST_FORM_MAX_BYTES` (60 000), in both languages of the admin; the schema refuses the same measure on the
  server. The global proxy limit is deliberately not raised.
- **Description of a post:** the meta description, else the excerpt, else the first paragraph of the body (about 155 characters),
  never the site-wide sentence. A tag page has hreflang and a language switch only when the tag is in use in both languages. A
  page number past the last one is a 404 and never gets a cache key (the count is read first, one key per list).
- **Timing:** a scheduled post goes live in about 62 seconds after its time (the proxy's address set refreshes every 60 seconds); the
  sitemap is immediate; the lists and counts can lag up to 5 minutes (the data cache TTL); an admin change is immediate (`updateTag`).
- **Database rules (0028 and 0029):** slug format and the reserved address `tag`; tags checked PER ELEMENT by the function
  `blog_tags_ok` (one dimension, no NULL, each a word with hyphens of at most 40, at most ten); a published post has text in some
  language. Both migrations stop with the ids of the rows that break a rule, and a failed run rolls back completely: fix the listed
  rows by id and run `pnpm db:migrate` again (also in `docs/DEVELOPMENT.md`). 0028 takes an ACCESS EXCLUSIVE lock for a full
  scan (it relies on a tiny table); 0029 adds its constraints `NOT VALID` and validates them. Snapshot `blog_posts` before applying.
- Markdown fidelity (also in the editor hint): `##` and `###` headings, bold, italic, lists, quotes and links; a link address with
  parentheses, `#` as a heading and pictures are not supported.
- Not built: a cover picture and inline pictures, comments, related posts and automatic internal links, a feed, numbered-page
  self canonicals (page 2 and later are noindex with a canonical to page 1).
