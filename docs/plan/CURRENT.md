# CURRENT.md: working state

> Memory between sessions. State lives here and in git, not in context.
> **The agent updates this file as the last action of every session.**

## Current phase

**Phase 1, "catalog and base SEO": 8 of 9 acceptance criteria verified by execution** (2026-11-23).
The ninth (Google's Rich Results Test) needs a public URL: a structural JSON-LD check passed instead.
Evidence per criterion: `docs/plan/phase-01-catalog.md`. Phase 2 (checkout) starts in a NEW session.
Standing rules (`AGENTS.md` section 0): technical text in English; one phase per session.

Infra: staging `https://staging.damazla.com` (basic auth), Hetzner CAX11, Dokploy
`https://dokploy.damazla.com`, daily dump to R2. Next 16.4.6 (PR #39).

## Done (phase 1, merged PRs)

- #34 SEO skeleton (runtime `SITE_URL`, one hreflang source, `/uk/*` 308, security headers, global 404)
- #35 bra size calculator · #36 typed JSON-LD builders · #37 catalog read layer in `core` (DTOs, search)
- #40 shell, home, category page with filters on cached reads · #42 product page (ISR, tags, JSON-LD)
- #43 search page and per-client rate limit · #45 home showcases, favicon · #44 CI `smoke-web` job (owner)
- #47, #48 limiter hardening (trusted proxy hop, route match, IPv6 /64, global cap) and review nits
- Verified on `main` + #48: `pnpm verify` (505 unit), `pnpm test:int` (231), `pnpm smoke:web` (49 checks)
- N+1 (`pg_stat_statements`, cache-miss requests): listing 2 statements for 38 and 338 products; product
  page 8 cold / 0 warm; search 1; home 4 cold / 0 warm. Lighthouse mobile 100 across (see phase file)

## Next step

1. Phase 2 (checkout) by the standing go-ahead, in a NEW session; read `phase-02-checkout.md`.
2. Owner: answer the queue items below; run Google's Rich Results Test once staging is reachable.

## Open decisions for the owner (full list: `docs/plan/OWNER_QUEUE.md`)

- Q19 bra size table (standard European one is a placeholder); Q1 shop name, palette, favicon
- Q21 cold start in a database outage: alerts, readiness probe, warm pages, edge rate limit
- Q22 `notFound()` from matched pages is answered with Next's empty `__next_error__` shell (framework-wide)
- Q23 no `revalidateTag` caller yet: build the invalidation endpoint before any admin mutation
- Q24 proxy trust (`TRUSTED_PROXY_HOPS`, Traefik `trustedIPs`, Cloudflare); Q25 global search cap fails
  hard for availability (about 20 addresses exhaust it)
- Still open from phase 0.5: Q13 to Q17 (Mono sandbox, outbox watcher, COD rules), Q2 and Q3 accounts

## Deviations from the plan

- Home page is rendered per request (not ISR): its navigation can be missing when the database is down on a
  cold start, and ISR would keep that. The product page is ISR; category pages are dynamic (`searchParams`)
  behind the data cache. Search is deliberately uncached (free-text key space)
- Not built: attribute filters (no data), add to cart (phase 2), reviews and ratings markup, category SEO
  text (needs a sanitiser), real photos (seed has a placeholder; `packages/media` is later), cache purge
- A product without a photo has no `Product` markup; no `aggregateRating` until ratings are visible
- Search is limited in process memory per /64 or IPv4 address plus a global cap; shared limiter is phase 12
- `notFound()` from a matched page is a real 404 with `noindex` but an empty server body (Q22)
- Earlier: TS 6.0.3; Tailwind v4 tokens in CSS; staging basic auth in `proxy.ts`; hooks are Node scripts;
  phase 0.5 deviations (core-level money skeleton, no worker deploy) stand until their phases
