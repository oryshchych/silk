# MARKETING.md

Phase 11 marketing features: what each does, who it may mail, and where the consent lives. English technical text.

## Abandoned cart reminder

- **Who:** a signed-in customer with an active, confirmed `newsletter_subscribers` row AND `customers.accepts_marketing`.
  A guest cart has no address (checkout asks for it only at the end) and is never mailed. Capturing an address earlier
  would need consent copy and a schema change: owner queue Q89.
- **When:** the cart changed at least 2 hours and at most 72 hours ago, has items, was not converted, and the customer
  placed no order (by account or by address) since the cart last changed.
- **Once:** `carts.abandoned_email_sent_at` is set by one conditional UPDATE and never cleared; the outbox row has the dedup
  key `cart-reminder:<cart id>`; the provider call carries an idempotency key. Two workers cannot claim one cart.
- **At send time** the handler re-reads the facts (converted, ordered since, consent withdrawn, goods sold out) and sends
  nothing when any holds. The mail shows no price. It carries the unsubscribe link.
- **Job** `carts.remind-abandoned` every 15 minutes (Kyiv zone), topic `email.cart-reminder` (queue in `OUTBOX_TOPICS`).
- **Unsubscribe link:** `/unsubscribe/marketing?t=<subscriber id>.<HMAC>` (key derived from `AUTH_SECRET`, purpose
  `marketing-unsubscribe`). Opening it changes nothing; the button POSTs. It sets `newsletter_subscribers.unsubscribed_at`
  and clears the customer flag, with one audit row naming the subscriber id (never the address).
- Not built: a `List-Unsubscribe` header (the sender interface carries no custom headers yet).
