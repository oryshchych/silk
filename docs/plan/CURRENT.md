# CURRENT.md: working state

> Memory between sessions. State lives here and in git, not in context.
> **The agent updates this file as the last action of every session.**

## Current phase

**Phase 4, "admin: access control and catalog": 9 of 11 acceptance criteria verified by execution**
(2026-11-25); two left unchecked (below) plus scope items not built. Evidence: smoke names in
`scripts/smoke-admin.ts` and the tests named below. Phase 5 starts in a NEW session after the
owner's go-ahead. Standing rules (`AGENTS.md` section 0): technical text in English; one phase per session.

Infra: staging `https://staging.damazla.com` (basic auth), Hetzner CAX11, Dokploy. Next 16.4.6.

## Done (phase 4, merged PRs)

- #62 Q35 migration; #63 auth (own session layer, TOTP, roles, `adminAction`, SECURITY.md tables held to
  code by tests); #64 stock history; #65 catalog write layer, editor, 301s, trusted tag invalidation
- #66 categories, dictionaries, attributes; #67 CSV import and export; #68 media; #69 stock screen
- On `main` (b5ce820): CI 15/15 on every PR; `pnpm test:int` 500 tests in 24 files; smoke-web covers the
  admin, catalog, import, export, taxonomy and media checks

## Next step

1. Owner: Q40 (set `AUTH_SECRET`, create the first owner with `scripts/admin-user.ts`, sign in on staging),
   Q45 (real R2), then Q38, Q39, Q41 to Q47. Earlier open: Q1, Q2, Q3, Q8, Q13, Q19, Q24, Q31 to Q34, Q36, Q37.
2. Phase 5 (admin orders) in a NEW session, after the go-ahead.

## Acceptance criteria

- [x] `content` gets 403 on a price change, UI and direct POST: smoke "catalog: a content role POSTing a price"
- [x] 100 rows with 3 broken: 97 imported, 3 errors with line numbers: `catalog-import.int.test.ts`, smoke "import"
- [x] Slug change gives a 301, both locales, a draft is not revealed: smoke "catalog: renaming a product"
- [x] Every mutation audited with author and diff: `MissingAuditError`; `stock-action.int.test.ts`
- [x] Edit visible at once in the admin, on the storefront within a revalidation: smoke "a price change shows"
- [x] Theme without flash (cookie sets `data-theme` on the first HTML): smoke
- [x] Admin theme does not touch storefront HTML or cache: smoke "storefront: no admin theme attribute"
- [x] One product change leaves other pages cached: smoke "changing one product leaves another"
- [x] `SECURITY.md` matches the code: permission and mutation tables are tested against it
- [ ] 3 colours x 12 sizes in under 10 minutes: 36 variants are made once (`catalog-admin.int.test.ts`); no timed run
- [ ] 4000 px photo as WebP <= 150 KB on the PDP: a 3000 px photo through the real route gives a 1600 px WebP
  under 150 KB against a signing fake store (smoke); no real R2, no 4000 px sample, the PDP ignores renditions (Q45)

## Not built or not verified

- Drag and drop category tree; XLSX (Q46); bulk actions in the product list; photos linked to a colour on
  the PDP; live SEO snippet preview not checked; staging sign-in (Q40)

## Caveats

- Local smoke shows storefront and checkout FAILs on a stale dev database; CI is authoritative
- `auth.int.test.ts` timing test failed once under full-suite load, passes alone: flaky candidate (`NOTES.md`)

## Deviations from the plan
- Own session layer instead of Auth.js (Q38); mobile refresh rotation deferred (Q39); no revalidate endpoint
- Stocktake below reserved is refused (Q44); upload route outside the proxy matcher with in-flight slots, a
  read deadline and malloc tuning; hand-signed S3 client
- Owner queue entries added: Q38 to Q47
