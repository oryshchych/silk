# SECURITY.md: who may do what, and where it is checked

Created in phase 4 and kept in step with the code. Two tests hold it to that:
`packages/core/src/auth/security-doc.unit.test.ts` fails when the permission table below differs
from `PERMISSIONS` in `packages/core/src/auth/permissions.ts`, and the per-role serialisation tests
(`packages/core/test/`, `scripts/smoke-web.ts`) check the DATA a role receives, not what the UI shows.

## The rule

Access control lives **inside** the code that does the work (`AGENTS.md` section 2.6):

1. An admin mutation is a server action built with `adminAction` (`apps/web/src/lib/admin/action.ts`).
   It runs, in this order: Origin (CSRF) -> full session read from the database -> the ONE
   permission the action names -> per-user rate limit -> zod validation -> a transaction that must
   write `audit_log`. A role without the permission is refused before the input is parsed.
2. A page of the admin calls `requireFullSession()`; it redirects to the right login step.
3. `proxy.ts` only limits, sets headers and saves a round trip for a request with no cookie. It
   decides nothing: a forged cookie passes it and is refused by the page or action.
4. The session token only names a row of `auth_sessions`. Revocation, `is_active`, role and MFA
   are read from the database on every request, never from the token (ADR-19).

## Roles and permissions

Roles: `owner` (everything), `admin` (everything except users and roles), `manager` (orders, stock),
`content` (catalog text and media, never prices, cost or money). `owner` and `admin` must hold a
confirmed TOTP before a session counts; so must anyone who enrolled one.

<!-- permissions:start -->
| Permission | Roles | What it covers |
|---|---|---|
| `admin.view` | owner, admin, manager, content | Any admin page |
| `users.manage` | owner | Create, deactivate, change the role of admin users |
| `catalog.edit` | owner, admin, content | Product text, categories, attributes, SEO fields |
| `catalog.price` | owner, admin | Price, old price, promo price of products and variants |
| `catalog.cost.view` | owner, admin | See `cost_price` / `unit_cost_snapshot` anywhere (screens, exports) |
| `catalog.publish` | owner, admin, content | Publish or unpublish a product |
| `stock.adjust` | owner, admin, manager | Change the stock of a variant (with history) |
| `media.upload` | owner, admin, content | Upload and edit product images |
| `catalog.import` | owner, admin | CSV / XLSX import |
| `catalog.export` | owner, admin | CSV / XLSX export |
<!-- permissions:end -->

## Mutations: who may, where it is checked

| Mutation | Permission | Checked in |
|---|---|---|
| Sign in (password, TOTP, recovery code, enrolment) | none (no session yet) | `actions/admin-auth.ts`: Origin, per-client limit, account lockout in `@store/core/auth` |
| Sign out | session | `logoutAction` reads the session itself; the cookie is cleared whatever the result |
| Theme and language of the admin | none (cosmetic cookie, `Path=/admin`) | `actions/admin-prefs.ts`: Origin; value outside the known list is replaced by the default |
| Catalog, stock, media, import, export | see the table above | added with their actions in the next slices; each names its permission in `adminAction` |

## Authentication facts

- Passwords: argon2id (19 MiB, 2 passes, 1 lane), per-hash salt, parameters stored with the hash.
  12 to 128 characters, must not contain the part of the email before the `@`.
- Five wrong passwords or TOTP codes in a row lock the account for 15 minutes (database time).
  A refusal never says whether the account exists, is locked or inactive; an unknown account still
  spends one password hash. Per-account serialisation is a transaction advisory lock, so a burst of
  parallel guesses cannot out-run the counter. A per-client limit sits in `proxy.ts` (30 a minute on
  the credential pages, 600 a minute over all clients) and again in the actions.
- TOTP secrets are AES-256-GCM encrypted at rest; keys are derived (HKDF) from `AUTH_SECRET`, one
  per purpose. A code is good once (`last_used_step`). Recovery codes are shown once, stored as
  SHA-256, single use.
- A password-only session is PENDING (10 minutes) and opens only the TOTP page; completing the
  second step issues a NEW session (the pending one is revoked: no fixation).
- Cookie `admin_session`: HttpOnly, SameSite=Strict, Secure outside local, `Path=/admin` (the browser
  never sends it to the storefront). The same token is accepted as `Authorization: Bearer` (mobile).
- `AUTH_SECRET` is required in production and must be at least 32 characters; without it nothing logs
  in and nothing resolves (fails closed).
- `audit_log` rows redact any key that looks like a credential (`password`, `secret`, `token`,
  `hash`, `code`, `key`, `cookie`, `authorization`). Authentication events are audited without the
  email or any secret.

## Responses

- Every admin response carries `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`
  (`proxy.ts` and `next.config.ts`, for every spelling of the path).
- The admin has its own root layout; its theme attribute exists nowhere in storefront HTML.
- Data for the browser goes through explicit DTOs (`toAdminSessionDto`: email, role, permissions;
  never the session row).

## Known gaps (owner queue)

- Mobile refresh-token rotation (the bearer token works, refresh rotation needs its own table).
- Password reset by email, and TOTP re-enrolment or user management screens: not in phase 4's plan;
  until then the owner resets an account with `pnpm admin:create`.
- QR code for enrolment: the key and the `otpauth` link are shown as text.
