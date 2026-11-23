# CURRENT.md: working state

> Memory between sessions. State lives here and in git, not in context.
> **The agent updates this file as the last action of every session.**

## Current phase

**Phase 2, "cart, checkout, delivery": 14 of 14 acceptance criteria verified by execution** (2026-11-23),
three with caveats (below). Evidence per criterion: `docs/plan/phase-02-checkout.md`.
Phase 3 (payments) starts in a NEW session. Standing rules (`AGENTS.md` section 0): technical text in
English; one phase per session.

Infra: staging `https://staging.damazla.com` (basic auth), Hetzner CAX11, Dokploy. Next 16.4.6.

## Done (phase 2, merged PRs)

- #52 core: migrations 0007 (quoted total, RR1 composite FKs, RR2 triggers) and 0008, quote guard,
  shipping fee, COD guards, expiry runner, cart merge, order lookup
- #53 web: cookie cart, cart, checkout, order success/failed/track, city autocomplete, consent checkbox
- #55 worker parts: Resend order emails, router, expiry/reconcile/Nova Poshta sync jobs (NOT deployed, Q31)
- Verified on `main` + #55: `pnpm verify` (568 unit), `pnpm test:int` (315), `pnpm smoke:web` (96 checks
  on the built app, including the shopper path), `db:check`, knip, boundaries, `ai:check`

## Next step

1. Phase 3 (payments) in a NEW session; read `phase-03-payments.md` and Q27 (reconciliation must exist
   before the expiry job ships) and Q31 (the worker needs an entrypoint and a deploy).
2. Owner: the items still open in `docs/plan/OWNER_QUEUE.md` (Q1, Q2, Q3, Q8, Q13, Q19, Q24, Q31).

## Open decisions for the owner (full list: `docs/plan/OWNER_QUEUE.md`)

- Q31 worker entrypoint and deploy (new env var for the pg-boss connection, `RESEND_API_KEY`, `EMAIL_FROM`):
  until then nothing sends the order emails, releases expired reservations or syncs the directory
- Q2 Nova Poshta key (the sync client is only tested against recorded-shape fixtures), Q3 Checkbox account
- Q13 Mono sandbox token, Q24 proxy trust (`TRUSTED_PROXY_HOPS` 2 behind Cloudflare), Q19 bra size table
- Q1 shop name and palette, Q8 backup check

## Caveats on the criteria

- Worker job (expiry): proven through a real pg-boss, but no worker process runs on staging (Q31)
- Cart merge at login: proven at core level; login arrives with phase 7, nothing calls it yet
- End-to-end in CI: HTTP level (server actions POSTed on the built app), not a browser (Playwright, Q6)

## Deviations from the plan

- `quoted_total` is set by `quoteCheckout` (not `startCheckout`): delivery and promo are unknown earlier
- Delivery fee is a flat tariff from `settings` (placeholder numbers); cards are off until phase 3
- Orders created from the storefront refuse without a quote and without accepted terms (audit entry,
  no column); the legal texts and their versions arrive with phase 8
- Promo answer is one public message; per-customer and first-order codes are refused for guests (Q28)
- Rate limits are in process memory (a full table refuses new clients, Q29); shared limiter is phase 12
- Not built: payment providers (phase 3), emails for payment and refunds, login merge (phase 7),
  worker deployment (Q31), real Nova Poshta calls (Q2)
- Earlier: TS 6.0.3; Tailwind v4 tokens in CSS; staging basic auth in `proxy.ts`; hooks are Node scripts;
  phase 0.5 and phase 1 deviations stand (see their phase files)
