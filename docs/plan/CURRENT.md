# CURRENT.md: working state

> Memory between sessions. State lives here and in git, not in context.
> **The agent updates this file as the last action of every session.**

## Current phase

**Phase 3, "payments": 13 of 16 acceptance criteria verified by execution** (2026-11-23), three
left UNCHECKED (and the Checkbox-sandbox half of the receipts criterion) because they need real
sandboxes or clients. Evidence per criterion, with test
names: `docs/plan/phase-03-payments.md`. Phase 4 starts in a NEW session. Standing rules
(`AGENTS.md` section 0): technical text in English; one phase per session.

Infra: staging `https://staging.damazla.com` (basic auth), Hetzner CAX11, Dokploy. Next 16.4.6.

## Done (phase 3, merged PRs)

- #58 providers: WayForPay (HMAC_MD5, signed accept) and Checkbox `FiscalProvider`, local fakes
- #59 payment flow: start payment (new attempt on the same order), `reconcileOpenAttempts`, COD and
  transfer confirmation, webhook routes `/api/webhooks/mono` and `/wayforpay`, card step, payments smoke
- #60 fiscal and worker: receipts in the payment transaction (card, COD at handover, return that points
  at the sale, transfer `not_required`), payment and refund emails (dark-mode shell), jobs
  `payments.reconcile-open`, `quarantine.cleanup`, `fiscal.reconcile`; the expiry job is now scheduled
- On `main` (814e591): `pnpm verify` 627 unit, `pnpm test:int` 400, `pnpm smoke:web` 139 checks,
  knip, boundaries, `db:check` clean. One test (`fulfilment` "no deadlock over 12 rounds") hits its 30 s
  limit on a loaded laptop and passes on a re-run; CI is green

## Next step

1. Phase 4 (admin catalog) in a NEW session. FIRST: the fiscal uniqueness migration (Q35: partial unique
   indexes for one sale per order and one return per refund, `last_reconciled_at` on
   `payment_attempts`) through `/new-migration` with `migration-reviewer`.
2. Owner: Q31 worker entrypoint, Dockerfile, compose service and env var (nothing runs the jobs until then),
   then the sandboxes: Q3 Checkbox, Q13 Mono token, Q32 WayForPay and the unconfirmed facts, Q33 dark-mode
   emails, Q36, Q37. Open too: Q1, Q2, Q8, Q19, Q24, Q34.

## UNCHECKED criteria (reason, queue entry)

- Sandbox payment end to end on staging, both providers: no credentials (Q13, Q32)
- Emails in dark mode in Gmail (iOS, web) and Outlook: needs the clients (Q33); contrast and colour
  scheme tests pass
- Receipts against the Checkbox sandbox (the second half of the receipts criterion; the first half, against
  the fake, is checked): no account (Q3, Q32)
- Return receipt carries the primary's fiscal number: the document points at the sale and waits for
  it, but the adapter does not send the number and the real return shape is unconfirmed (Q32)

## Caveats

- Worker not deployed (Q31): reconcile, expiry, receipts, emails and cleanup run only from tests
- Fakes sign like the adapters: consistency, not correctness; a recorded real sample is still missing
- Cards are off in `payment_providers` and no provider credentials exist on staging, so no card is offered

## Deviations from the plan
- `payments.reconcile-open` every 10 minutes (plan: hourly), so the expiry job holds stock briefly
- A live invoice is reused, never cancelled at the provider; "another card" works after a failed or
  expired attempt (Q34). Reconcile closes a not-found attempt only if it never had an invoice (Q36)
- Receipts: a duplicate charge refund gives a full-sale return receipt (Q37); gift cards get none (ADR-20)
- Added env vars `MONO_API_BASE_URL`, `WAYFORPAY_API_BASE_URL`, `WAYFORPAY_MERCHANT_DOMAIN`,
  `PAYMENT_PAGE_HOSTS`; `proxyClientMaxBodySize` 64 KB, web `mem_limit` 1g
- Earlier phase deviations stand (see their phase files)
