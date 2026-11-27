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
  `newsletter_subscribers` row (`confirmed_at` empty) and queues `email.newsletter-confirm`. It stores no consent.
- **Same answer for everyone:** new, pending, subscribed and previously unsubscribed addresses all get "check your inbox"
  (nobody learns who is on the list). At most one confirmation mail per subscriber per hour (the outbox dedup key carries the
  database hour); a hidden honeypot field is answered as a success and stores nothing; 5 requests per 10 minutes per client.
- **Confirm:** `/newsletter/confirm?t=<id>.<expiry>.<HMAC>` (key purpose `newsletter-confirm`, valid 48 hours). Opening the link
  changes nothing; the button POSTs. It confirms a PENDING row only, so an old link cannot re-subscribe someone who
  unsubscribed since; it also sets the account flag when a customer with that address exists.
- **Consent evidence:** `confirmed_at` is the consent time, `unsubscribed_at` its end; audit rows `marketing.subscription_requested`
  and `marketing.subscription_confirmed` carry the wording version, the source and the language, never the address or an IP.
- **Unsubscribe:** the signed `/unsubscribe/marketing` link of slice B (every marketing mail carries it).
- Not built: sending campaigns (no mailer for bulk mail yet), a subscribers screen in the admin, bounce handling.
