# CURRENT.md: working state

> Memory between sessions. State lives here and in git, not in context.
> **The agent updates this file as the last action of every session.**

## Current phase

**Phase 9, "content and catalogue filling": the TOOLING is built and merged (3 PRs); the three acceptance criteria are the OWNER's
content work and are NOT done by the agent** (2026-11-26, about 2 h 35 min from the go-ahead to the last merge). The agent wrote
no product text, photo, price, stock or SEO text and seeded nothing into staging or production.
PRs: #99 (`content:check`, readiness report), #100 (admin screen, category text editor), #101 (CSV import route, content columns,
template, preview notes, the guide). Rounds: each PR two (FAIL, one fix push, PASS). Longest waits: about 13 min for the specialists
on #101, about 10 min for CI on #101 (one timing flake re-run). Process failures (author): 6 (a storefront edit lost by a glob
pathspec checkout, caught by the smoke; three commit headers refused by commitlint; docs files swept into #101 by `git add -A`,
folded in on purpose; a smoke case with a 4-byte "slow" body).
Phase 10 starts in a NEW session on the standing go-ahead (`docs/AUTONOMOUS_MODE.md`). English technical text; one phase per session.

Infra: staging `https://staging.damazla.com` (basic auth). Next 16.4.6. The worker is still not in `docker-compose.yml` (Q31).

## Done (phase 9, merged PRs)

- #99 `pnpm content:check [--gate|--json|--expected-active=N|--allow-remote]`: read-only transaction, URL only from `DATABASE_URL`, allowlisted target (remote needs `--allow-remote`, production words refused), exit 0/1/2; the report (`packages/core/src/content-readiness`, DTO with no cost field) judges every product, category and photo in 4 set-based queries; the storefront now renders the category SEO text
- #100 `/admin/content-readiness` (`admin.view`, shared 60 s count, pages of 100, filter before the page is cut); `/admin/categories/<id>` editor for the category texts (`categories.edit`: before this nobody could write them through the admin)
- #101 `POST /admin/upload/products-csv` (own route, 2 MB / 1000 rows, same safeguards as the photo upload), content columns, template download with a refused example row, preview notes, export with the same columns; `docs/CONTENT_GUIDE.md` (a test fails when it drifts from the tools); owner queue Q81 to Q84; `cleanText` on every admin text input

## Next step

1. Owner hands: Q81 (the content itself, then `pnpm content:check --gate --allow-remote` against staging), Q45 (media bucket: photos cannot be uploaded before it), Q76, Q40, Q63, Q62.
2. Owner and lawyer: Q77, Q79, Q75, Q80 (legal texts), then the launch checklist in the guide, section 8.
3. Phase 10 in a NEW session.

## Acceptance criteria

- [ ] 40 products active, with variants, stock and photos: the owner's work; measured by `content:check` (check `active_products`, `variants_stock_photos`); the tool itself: `content-readiness.int` 28 tests, `content-check-script.int` 10 tests, smoke "content:" on the built server
- [ ] No product without alt text, meta description or photo: the owner's work; measured by check `alt_meta_photo`; tested with one-language alt, empty and zero-width text, over-long meta, a missing rendition
- [ ] Every category has an SEO text: the owner's work; measured by `category_seo_text`; the editor exists (#100) and the storefront shows the text (smoke, uk and en)

## Not built or not verified

- No real content exists; nobody has run the gate against staging (Q81); no real browser pass, no Excel or LibreOffice opening of the template
- Photos: no upload against real R2 (Q45); duplicates are not detected (no hash stored, Q82); the bucket is not listed (Q47)
- The CSV cannot carry variants, stock, photos, alt text or attributes (entered in the product card); XLSX stays queued (Q46)
- `?refresh` and POST to the screen are bounded by the shared count, not by a 405

## Caveats

- Full local `test:int` can flake under load (one webhook, one auth timing test failed once each, pass alone); CI is authoritative
- The meta title bound (46) assumes the placeholder shop name (Q1, Q84): a test fails when the name outgrows the reserve
- The smoke "search finds products despite a typo" fails on a hand-built local database; CI on the project image is green

## Deviations from the plan

- Phase 9 is not an agent phase: the agent built tooling only, and found and closed two gaps the criteria depend on (category text never rendered, no admin form for it)
- Slices B and C absorbed the category editor and the guide; the phase ran as 3 PRs plus this report
