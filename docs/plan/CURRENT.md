# CURRENT.md: working state

> Memory between sessions. State lives here and in git, not in context.
> **The agent updates this file as the last action of every session.**

## Current phase

**Phase 7, "customer account, reviews, returns": built and merged (5 feature PRs); 4 of 4 acceptance criteria verified by
execution, with named gaps** (2026-11-26, about 2 h 50 min from the go-ahead to the last merge). 6 PRs (#88 to #92 and the
small #93), each of #88 to #92 went FAIL, one fix push, PASS (2 rounds), #93 one round; 4 of the 5 FAILs carried a blocker. Longest wait: the
orchestrator's re-check of #90, about 30 min; the specialist reviews took 15 to 25 min each. Process failures (author): 5.
Phase 8 starts in a NEW session on the standing go-ahead (`docs/AUTONOMOUS_MODE.md`). Standing rules (`AGENTS.md` section 0):
English technical text; one phase per session.

Infra: staging `https://staging.damazla.com` (basic auth), Hetzner CAX11, Dokploy. Next 16.4.6. The worker is still not described in
`docker-compose.yml` (Q31), so no e-mail leaves the system yet (order, account and back-in-stock mails included).

## Done (phase 7, merged PRs)

- #88 customer accounts: register by mailed link (the person sets the password), sign-in, reset, sessions with an `audience`, migrations 0015 and 0016
- #89 orders with tracking and reorder, profile, ten addresses, newsletter consent, saved sizes ("your size" via a client-only cookie)
- #90 wishlist and back-in-stock alerts (worker job, signed unsubscribe link); queues for the three customer mail topics (also repaired #88)
- #91 reviews by verified buyers, moderation (`reviews.moderate`), counters from approved rows, `AggregateRating`; migrations 0017 and 0018
- #92 return requests, receipt-only restock, refund of what was RECEIVED through the phase 5 flow (`returns.manage`); migrations 0019 and 0020
- #93 fix: the account client components had no messages namespace (raw keys on every account page since #88), smoke now checks it

## Next step

1. Owner hands: Q63 (the worker needs `AUTH_SECRET` and a deployment before any mail goes out), then the older ones (Q62, Q40, Q45, Q13).
2. Owner legal texts (phase 8): Q64 accounts, Q71 returns policy and window, Q73 review terms.
3. Phase 8 in a NEW session on the standing go-ahead.

## Acceptance criteria

- [x] A review only from a buyer of THAT product: `reviews.int` (own order, product line, shipped/delivered/paid; another customer, a pending or cancelled order refused; mutation: no customer scope fails)
- [x] The fit share comes from real `fit_feedback`: `reviews.int` (counters from approved rows, 100%, 50%, parallel moderators on different reviews)
- [x] The back-in-stock alert fires on restock: `wishlist-alerts.int` (4 parallel workers claim 6 alerts once), worker `back-in-stock.int`, `customer-topics-delivered.int` (real relay and pg-boss)
- [x] A return is created, processed in the admin and changes stock at the receipt: `returns.int` 27 tests, smoke-admin returns checks; the sender itself (Resend) was never called, a fake was used

## Not built or not verified

- A customer can edit or delete neither a review nor an address (no edit, no set-default control), no Nova Poshta address form, no account deletion or data export (Q66)
- No marketing mailer or marketing unsubscribe, no `List-Unsubscribe` headers (Q69, Q70), no photo reviews, no exchange flow, the order status is not moved to `returned` (Q72)
- Review and return submission were not exercised over HTTP in smoke (int tests only); no real mail, no real browser pass
- Legal texts are neutral placeholders (Q64, Q71, Q73)

## Caveats

- The account credential forms share a global attempt cap that one attacker can fill (accepted risk, Q67)
- Full local `test:int` can time out under machine load; CI is authoritative
## Deviations from the plan
- Registration starts with an address and the person sets the password on the mailed link (pre-hijack); customers are separate from admins (audience column, separate keys)
- Owner queue entries added: Q63 to Q74
