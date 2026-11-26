# CURRENT.md: working state

> Memory between sessions. State lives here and in git, not in context.
> **The agent updates this file as the last action of every session.**

## Current phase

**Phase 8, "legal and static pages": built and merged (2 feature PRs); 4 of 4 acceptance criteria verified by execution as a
MECHANISM, every text is a draft that needs a lawyer** (2026-11-26, about 1 h 35 min from the go-ahead to the last merge).
PRs: #96 (legal documents, admin, sanitiser, PDF upload) and #97 (public pages, footer, disclaimer, sitemap, one returns policy,
consent versions). Rounds: #96 two (FAIL, one fix push, PASS), #97 two (the same). Longest wait: about 30 min for the specialists'
findings on #97. Process failures (author): 5 (a flaky same-millisecond fixture that failed CI; a Ukrainian technical note caught by
the language gate; a smoke case that still used a now-refused return reason; two harness slips in the #97 fix round) plus two
author PASS comments posted before the specialists had reported, which the consolidated FAIL comments then superseded.
Phase 9 starts in a NEW session on the standing go-ahead (`docs/AUTONOMOUS_MODE.md`). Standing rules (`AGENTS.md` section 0):
English technical text; one phase per session.

Infra: staging `https://staging.damazla.com` (basic auth), Hetzner CAX11, Dokploy. Next 16.4.6. The worker is still not in
`docker-compose.yml` (Q31), so no e-mail leaves the system yet. Staging has NO published legal documents until the owner (or the
seed on an empty database) publishes versions: the footer then lists nothing and `/legal/*` answers 404.

## Done (phase 8, merged PRs)

- #96 `legal_documents` versioned (migrations 0021, 0022): a published version is immutable and undeletable (trigger on every column), the current one is chosen by the DATABASE clock, a later start cannot be overridden; admin screens, `legal.edit` (content may draft) and `legal.publish` (owner, admin); Markdown subset plus allowlist sanitiser (write, read, render); PDF upload route (`%PDF-` by bytes, 8 MB, attachment, `private, no-store`)
- #97 `/legal/<slug>` in uk and en (ISR, tags, proxy 404 gate, hreflang only when both languages are published, FAQPage from visible questions, sitemap with the real lastmod), footer links, trademark disclaimer on every page, About and Contacts from settings with "not set" markers, neutral draft templates marked "Draft: needs a lawyer"
- #97 one returns policy (`packages/shared/src/return-policy.ts`): page summary, return form, server check and `hasMerchantReturnPolicy` come from the same constants; per product class (underwear and hosiery "not permitted", homewear no claim); the edition of the text is recorded (`return_requests.policy_version`, order, registration and newsletter audit rows)

## Next step

1. Owner hands: Q76 (media host headers: a RELEASE GATE before any legal PDF is published), Q63, Q62, Q40, Q45, Q13.
2. Owner and lawyer: Q77 (replace the draft texts and fill `settings.company` and `settings.contacts`), Q79 (homewear returns, needs a lawyer), Q75 (returns window versus Resolution 172), Q80 (remove the draft banner before launch), Q64, Q71, Q73.
3. Phase 9 in a NEW session.

## Acceptance criteria

- [x] All pages exist in uk and en: 7 kinds in both languages from the templates (`legal.int` "templates"); the smoke publishes 13 of 14 on purpose (`about` in uk only, to exercise the one-language path) and asserts the rendered text of each
- [x] The returns page does not contradict Resolution 172: summary built from the constants, cites the Resolution, lists accepted and refused reasons (`return-policy-consistency.unit` 15 tests, smoke "returns uk/en"); NOT reviewed by a lawyer
- [x] `hasMerchantReturnPolicy` equals the page: consistency unit and smoke (a bra page says not permitted with a link, a pyjama page carries no claim, identical for every visitor); the server refuses the other reasons (`returns.int`)
- [x] The trademark disclaimer is on every page: smoke loop over 12 page kinds in both languages, the 404 pages included (`global-error` not exercised)

## Not built or not verified

- EVERY legal text is a neutral draft that needs a lawyer; no company facts exist (legal name, tax id, address, phone) and no admin screen edits `settings.company` (Q77)
- No real PDF served through R2 (Q76), no HTTP probe of the PDF route against a built server (route tested with a real handler, Postgres and a signature-checking fake S3)
- Checkout, registration and returns consent refs were not probed over HTTP (int tests and code only); a real publish around a cache refresh was read from code, not observed
- No real browser pass, focus order or contrast check; no e-mail sent

## Caveats

- Full local `test:int` can time out under machine load (account-data, stock, catalog-admin each flaked once, all pass alone); CI is authoritative
- The proxy gate for legal pages reloads once a minute and at once on a publish in the same process
## Deviations from the plan
- Slices B and C shipped as one PR (the returns summary sits on the public page); the phase ran as 2 PRs, not 3
- The owner queue gained Q75 to Q80; the old placeholder constant `v0-placeholder` is now only the "nothing published yet" value
