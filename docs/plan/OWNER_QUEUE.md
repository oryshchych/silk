# Owner queue

Everything that needs the owner. Sessions add entries as they find them; the
owner answers when back. Protocol: `docs/AUTONOMOUS_MODE.md`.

- **BLOCKER**: the work cannot continue without the answer.
- **DEFER**: work continues with the recommended default; the owner can overrule.

Newest entries go at the top of the open table. Move answered entries to
"Answered" with the decision and date.

## Open

| ID | Raised | Item | Class | Needed by | Options and recommendation |
|---|---|---|---|---|---|
| Q13 | 2026-11-22 | Mono sandbox token: the Mono adapter has only run against a local fake. Facts to confirm on the real sandbox: a partial `reversed` webhook shape, whether `modifiedDate` is always present, whether `/invoice/cancel` returns an id of its own | DEFER | end of phase 0.5 | Recommended default: keep building against the fake; put the sandbox token in the local `.env` (never in chat), run the adapter against it once at the end of phase 0.5 and record the findings in `NOTES.md` |
| Q12 | 2026-11-22 | Checkout intent binds the cart version but not the price the buyer saw: a `base_price` change between "see total" and "pay" is charged silently. Fixing it needs a new column (`checkout_intents.quoted_total`), so it is a schema change | DEFER | phase 2 (checkout UI) | Recommended default: add `quoted_total integer` to `checkout_intents`, set it in `startCheckout` from `calculateCart`, compare in `createOrder` and throw a new `PriceChangedError` (409). Until then the total shown on the page can differ from the charge only after an admin edit; the order always stores the real total. Also: `promo_uses_lte_max` CHECK already exists in the schema, nothing to add for promo overshoot |
| Q11 | 2026-11-22 | The merge gate (PR #19) still fails its third security audit: a command-text classifier cannot be made complete (dynamic program names, `gh api` writes, flag clusters, heredoc quoting, git config redirection, editable gate files). The allow rule for the merge command is already live in that branch's settings | BLOCKER for unattended merging | when you are back | Option A (recommended): enable branch protection on `main` (Q9), then merge #19 as a guard rail and merge PRs yourself or let sessions do it. Option B: drop the allow rule and keep merging manual. Option C: another fix round of the classifier plus a deny on editing the gate files, accepting it stays advisory |
| Q10 | 2026-11-22 | PRs that change the guard rails (`.claude/**`, gate scripts, workflows, `docs/AUTONOMOUS_MODE.md`) are never merged by a session; the first one is the merge-gate PR itself (#19) | BLOCKER for that PR only | when you are back | Review and merge them yourself; sessions keep working on everything else |
| Q1 | 2026-11-22 | Shop name (`LACE & SILK` is a placeholder), brand palette and fonts | DEFER | before launch | Keep the placeholder and neutral tokens; branding is a token change, not a rewrite |
| Q2 | 2026-11-22 | Nova Poshta API 2.0 access (key) | DEFER | phase 2 live shipping | Build against a recorded fake; plug the real key in at the end of phase 2 |
| Q3 | 2026-11-22 | Checkbox account (test cash register) | DEFER | phase 3 fiscal sandbox | Build `FiscalProvider` against the documented API with a fake; verify against the sandbox when the account exists |
| Q4 | 2026-11-22 | COD paper receipt printed into the parcel | DEFER | phase 5 | Recommend a printable receipt view in the admin order screen; printer and format are the owner's call |
| Q5 | 2026-11-22 | A return receipt may point only to a `sale` receipt; a foreign key cannot express it | DEFER | phase 3 / 5 | Recommend a `kind` column plus a composite FK so the DB enforces it |
| Q6 | 2026-11-22 | Phase 0 scope not done: CI jobs `migrate:upgrade`, `migrate:safety`, `size-limit`; Playwright; shadcn/ui; `jsx-a11y` (waits for ESLint 10 support) | DEFER | phases 0.5 to 1 | The orchestrator adds the `test:integration` CI job first; the rest when the first real flow needs them |
| Q7 | 2026-11-22 | Merged branches still on GitHub: `docs/accountant-answers`, `feat/db-migrations`, `feat/db-client-seed`, `feat/money-dto` | DEFER | whenever | Delete them in the GitHub Branches page; agents are not allowed to delete remote branches |
| Q8 | 2026-11-22 | Phase 0 criterion 20: the first scheduled nightly backup after 03:00 Kyiv on 2026-11-23 | DEFER | 2026-11-23 | The orchestrator checks the R2 bucket (`staging/` must hold a second file); otherwise the owner does |
| Q9 | 2026-11-22 | `main` has no branch protection. The merge gate only covers commands run by agent sessions; an agent script, a typo or a leaked token could still push to `main`. Found by the security audit of the merge gate | DEFER (recommended soon) | before long unattended runs | Enable a ruleset on `main`: require a pull request, require the CI checks, block direct pushes (keep yourself as bypass actor if you want). Agents may not change repository settings, so this is yours |

## Answered

| ID | Answered | Decision |
|---|---|---|
| | | |
