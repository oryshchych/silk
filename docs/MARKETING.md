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
  by Postgres' `now()` when the cache fills, a 60 second TTL moves it over a boundary and an admin change drops the tag
  `banners` after the commit. The ISR pages (product, category) never import banners (pinned by `banners.unit.test.ts`),
  so no banner change can make a shared page differ between visitors or go stale.
- **Rendering:** one `<picture>` per banner, mobile sources under `(max-width: 767px)`, AVIF, WebP and the original, the box
  reserved from the stored dimensions, the first banner the LCP candidate and the rest lazy.
- Not built: banner positions other than `home_hero`, per-banner statistics, scheduling per locale. Files of a DELETED banner stay
  in the bucket (the weekly orphan job of Q47 lists `products/` only).
