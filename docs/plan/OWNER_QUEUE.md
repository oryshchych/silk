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
| Q1 | 2026-11-22 | Shop name (`LACE & SILK` is a placeholder), brand palette and fonts | DEFER | before launch | Keep the placeholder and neutral tokens; branding is a token change, not a rewrite |
| Q2 | 2026-11-22 | Nova Poshta API 2.0 access (key) | DEFER | phase 2 live shipping | Build against a recorded fake; plug the real key in at the end of phase 2 |
| Q3 | 2026-11-22 | Checkbox account (test cash register) | DEFER | phase 3 fiscal sandbox | Build `FiscalProvider` against the documented API with a fake; verify against the sandbox when the account exists |
| Q4 | 2026-11-22 | COD paper receipt printed into the parcel | DEFER | phase 5 | Recommend a printable receipt view in the admin order screen; printer and format are the owner's call |
| Q5 | 2026-11-22 | A return receipt may point only to a `sale` receipt; a foreign key cannot express it | DEFER | phase 3 / 5 | Recommend a `kind` column plus a composite FK so the DB enforces it |
| Q6 | 2026-11-22 | Phase 0 scope not done: CI jobs `migrate:upgrade`, `migrate:safety`, `size-limit`; Playwright; shadcn/ui; `jsx-a11y` (waits for ESLint 10 support) | DEFER | phases 0.5 to 1 | The orchestrator adds the `test:integration` CI job first; the rest when the first real flow needs them |
| Q7 | 2026-11-22 | Merged branches still on GitHub: `docs/accountant-answers`, `feat/db-migrations`, `feat/db-client-seed`, `feat/money-dto` | DEFER | whenever | Delete them in the GitHub Branches page; agents are not allowed to delete remote branches |
| Q8 | 2026-11-22 | Phase 0 criterion 20: the first scheduled nightly backup after 03:00 Kyiv on 2026-11-23 | DEFER | 2026-11-23 | The orchestrator checks the R2 bucket (`staging/` must hold a second file); otherwise the owner does |

## Answered

| ID | Answered | Decision |
|---|---|---|
| | | |
