# CURRENT.md: working state

> Memory between sessions. State lives here and in git, not in context.
> **The agent updates this file as the last action of every session.**

## Current phase

**Phase 0.5, "money skeleton": all 16 acceptance criteria verified by execution** (2026-11-23).
Next phase (1, catalog) starts only after the owner's explicit go-ahead, in a NEW session.
Standing rules (`AGENTS.md` section 0): technical text in English; one phase per session.

Infra: staging `https://staging.damazla.com` (basic auth), Hetzner CAX11, Dokploy
`https://dokploy.damazla.com`, daily dump to R2.

## Done (phase 0.5, merged PRs)

- #15 `acquireLocks` (ADR-22) · #17 `cart_version` trigger · #18 pricing, largest remainder
- #20 cart, checkout intent, `createOrder` · #22 `packages/payments` + Mono adapter
- #23 payment attempts + verified webhook handling · #29 outbox relay on pg-boss
- #30 `shipOrder` / `cancelOrder` · #31 refunds via `refund_operations` · #32 flaky test fix
- Verified on `main`: `pnpm verify` (358 unit), `pnpm test:int` (193), `pnpm migrate:fresh` (22)

## Next step

1. Owner reads the phase 0.5 report (PR "docs(plan): phase 0.5 report") and decides the items below.
2. Phase 1 only on the explicit go-ahead. Read `phase-01-catalog.md` then.
3. Phase 0 criterion 20 (nightly `pg_dump` to R2 after 03:00 Kyiv 2026-11-23): check `staging/` in the bucket.

## Open decisions for the owner (full list: `docs/plan/OWNER_QUEUE.md`)

- Q13 Mono sandbox token and three facts (partial `reversed`, `modifiedDate`, `extRef` idempotency)
- Q14 outbox send is not in the DB transaction (role split); Q15/Q17 watcher for stuck rows, dead
  letters and unreconciled refunds; Q16 COD and transfer shipping rules; Q12 quoted total on intents
- Whether the thin web slice (product page, cart, checkout UI, webhook route handler) is wanted before phase 1
- Shop name, brand palette; Nova Poshta and Checkbox access; merged branches still on GitHub

## Deviations from the plan

- Criteria were proven at the `core` / `payments` / `worker` level with real Postgres and pg-boss. NOT built:
  product page, cart and checkout UI, the web webhook route (reads the body as bytes), Mono sandbox runs
  (the adapter only ran against a local fake with a real EC key), worker deploy (no `main.ts`, Dockerfile,
  compose service or `store_boss` env)
- `shipOrder` jumps `pending`/`confirmed` straight to `shipped` (explicit skeleton entry in
  `orders/transitions.ts`); one-step admin transitions come with phase 5
- No `order.shipped` event or mail; no consumer for `alert.*` outbox topics yet
- `in_flight` and `unknown` refunds hold budget and block shipping until reconciled (no job, no refund
  status lookup in the adapter yet)
- Outbox relay is at-least-once on its own connection (roles); exactly-once for a mail rests on the
  provider idempotency key, which is bounded in time
- COD and bank transfer do not ship (only settled card payments); gift-card seams reject at checkout
- Earlier: TS 6.0.3; Tailwind v4 tokens in CSS; staging basic auth in `proxy.ts`; rclone 1.76.0; hooks are
  Node scripts; Ukrainian docs are rewritten when touched
