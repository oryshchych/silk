# CURRENT.md: working state

> Memory between sessions: state lives here and in git. Updated as the last action of every session.

## Current phase
**Phase 11, "marketing and blog": slices A to D and E1 built and merged; E2, auto-linking and F NOT built (owner stopped the phase
on 2026-11-27).** About 6 h from the go-ahead to the last merge (first PR 09:07 UTC, last merge 14:49 UTC). Phase 12 starts in a NEW
session on the standing go-ahead (`docs/AUTONOMOUS_MODE.md`). English technical text; one phase per session.

| PR | Slice | Fix rounds |
|---|---|---|
| #110 | A: promo codes admin tab (`/admin/marketing/promo-codes`) | 1 (5 should-fix) |
| #111 | B: abandoned cart, ONE reminder through the outbox | 1 (5 should-fix) |
| #112 | C: newsletter double opt-in (migration 0024) | 1 (2 blockers on consent, 6 should-fix) |
| #113 | D: home banners, desktop and mobile pictures (migrations 0025 to 0027) | 2 (5 should-fix, then restore of reformatted files) |
| #114 | E1: blog, tags, indexable posts, `Article` JSON-LD (migrations 0028, 0029) | 1 (8 should-fix) + 5 smoke-only fixes |

Longest wait: about 1 h 25 min for #114, opening to merge (CI about 6 min per push).
## Acceptance criteria (all executed)
- [x] Abandoned-cart mail once, not after an order: `apps/worker/test/cart-reminder-delivered.int` (real chain; later cron ticks send
  nothing; an order between claim and send sends nothing, `outbox.dead` empty) and `packages/core/test/marketing-carts.int`
  (14 tests: eligibility, two workers, send-time facts, per-customer cap, held carts)
- [x] Promo statistics equal `consumed` redemptions: `promo-admin.int` "statistics equal the consumed redemptions" and "money columns
  are net of refunds" (a mutation reading `uses_count` fails it)
- [x] Two parallel last uses, one passes: `create-order.int` "two checkouts racing for the last allowed use: one wins" (phase 2) and
  `promo-admin.int` "an edit and a checkout cannot interleave"
- [x] Two cancel paths at once free the use once: `promo-admin.int` "cancelling one order by two paths at once frees the use once"
- [x] Same answer for a missing and an exhausted code: `promo-admin.int` "the oracle stays closed", `checkout.int` "every refusal
  looks the same", plus the 30 per hour per cart session limit in `apps/web/test/checkout-promo-limit.int`
- [x] Blog post indexable with `Article` JSON-LD: `blog.int` (12+4 tests), `buildArticle` unit tests, and the blog checks of
  `scripts/smoke-admin.ts` in CI `smoke-web` (200, canonical, hreflang pair, index robots meta, `Article` markup, same bytes for every visitor)
## Not built, with the recommended default
- **E2, CMS pages** (table `pages`): default NOT to build until a page that is not a legal page is needed (about, contacts and faq are
  legal pages already). If needed, copy the blog slice (admin tab, gate, ISR page, sitemap): about one slice.
- **Automatic internal linking**: default NOT to build; write links by hand in the Markdown. If built: a small admin-owned keyword
  table (at most 3 links per post, product and category targets only), applied when the post is rendered, tested for escaping.
- **F, bought together**: default a nightly job that fills a `product_pairs` table from paid orders (never at request time), shown only
  with at least 5 co-purchases and in-stock partners; needs a migration. Build it after real order volume exists.

## Owner side (all in `docs/plan/OWNER_QUEUE.md`)
- **Q92** BEFORE migration 0024 is deployed anywhere: `SELECT lower(email), count(*) FROM newsletter_subscribers GROUP BY 1 HAVING count(*) > 1`
  and resolve pairs by hand (the dedupe keeps the oldest row whole)
- **Q31** worker and Resend (`RESEND_API_KEY`, `EMAIL_FROM`, the worker service): until deployed the cart reminder and the newsletter
  confirmation mail are queued, never sent. **Q90** `List-Unsubscribe` headers, built with Q31. **Q89** guests are not reminded.
  **Q91** the newsletter consent does not cover cart reminders. **Q93** banner drafts, files and the 0025/0026 snapshots. **Q94** no blog pictures
- Snapshot `banners` and `blog_posts` before applying 0025 to 0029 (forward-only). Staging has no worker, so `carts.remind-abandoned` does not run

## Not built or not verified
- No real browser pass (banner layout shift, LCP), no Rich Results Test, no real Resend or R2 run; limiters are per process
- No blog pictures or feed, no campaign sending or subscribers screen, no promo product picker
- Flaky under load, pass alone: `webhook.int`, `auth.int` timing, `catalog-admin.int`, "too many clients" in `locks.int` and `reports-all.int`

## Deviations from the plan
- E split: only the blog was built; CMS pages, auto-linking and bought-together were stopped by the owner (machine load)
- Six migrations (0024 to 0029) where the plan had none: consent integrity, banner rules, blog rules
- Process failures (author): `prettier --write` over `packages/db` reformatted 27 committed snapshots and `schema.ts` (caught in review,
  restored); my own first PASS comments on #110 and #111 missed what the specialists found (5 each); #112 had two consent blockers
  (a confirm link re-subscribed, a consumed link worked again); worker "dead letter empty" checks read `pgboss` through a role that
  cannot, so they proved nothing until #112; the smoke checks failed six times for test mistakes (duplicate account, `hrefLang`, the
  staging noindex header, stale caches); an extra edit script left a source file mutated once and killed runs left containers up
