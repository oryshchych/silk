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
`content` (catalog text and media; may READ prices, as the storefront shows them to everyone, but never write a price or see the cost). `owner` and `admin` must hold a
confirmed TOTP before a session counts; so must anyone who enrolled one.

<!-- permissions:start -->
| Permission | Roles | What it covers |
|---|---|---|
| `admin.view` | owner, admin, manager, content | Any admin page |
| `users.manage` | owner | Create, deactivate, change the role of admin users |
| `catalog.create` | owner, admin | Create a product (a draft: it needs a price) |
| `catalog.edit` | owner, admin, content | Product text, SEO fields, structure, variant SKU/barcode/active |
| `categories.edit` | owner, admin, content | Create, edit and move categories |
| `dictionaries.edit` | owner, admin | Colours, sizes, attributes and their values |
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
| Create a product | `catalog.create` | `createProductAction` (`actions/admin-catalog.ts`) via `catalogAction` -> `adminAction` |
| Edit product text, SEO, slug, category | `catalog.edit` | `updateProductContentAction`: never a price (a separate action) |
| Edit a price, the old price, the cost | `catalog.price` | `updateProductPricingAction`; writing the cost ALSO needs `catalog.cost.view` (checked in the action: a role that may not see the cost may not set it blind) |
| Publish or unpublish | `catalog.publish` | `setProductActiveAction` |
| Generate variants, edit a variant's SKU, barcode, active | `catalog.edit` | `generateVariantsAction`, `updateVariantContentAction` |
| A variant's price override | `catalog.price` | `updateVariantPricingAction` |
| Read the product list and editor | `admin.view` (+ `catalog.cost.view` for the cost) | `lib/admin` pages call `listAdminProducts` / `getAdminProduct` with the role's cost permission; the DTO schema for a role without it has no cost key |
| Create, edit and move a category (slug change leaves a 301) | `categories.edit` | `createCategoryAction`, `updateCategoryAction`, `moveCategoryAction` (`actions/admin-taxonomy.ts`) |
| Colours, sizes, attributes and their values | `dictionaries.edit` | `saveColorAction`, `saveSizeAction`, `saveAttributeAction`, `saveAttributeValueAction` |
| Assign attribute values to a product | `catalog.edit` | `setProductAttributesAction` |
| Upload a product photo | `media.upload` | `POST /admin/upload/product-image` (`app/admin/upload/product-image/route.ts`): its own route, see "Uploads" below |
| Edit a photo's alt text, colour, order; delete it | `media.upload` | `updateProductImageAction`, `deleteProductImageAction` |
| Preview and commit a CSV import | `catalog.import` | `previewImportAction` (writes nothing), `commitImportAction` (`actions/admin-import.ts`): a column the role may not write (price without `catalog.price`, cost without `catalog.cost.view`) turns the row into an error; each written row has its own audit row |
| Download the product CSV | `catalog.export` | `GET /admin/export/products` (`app/admin/export/products/route.ts`): the cost column only for `catalog.cost.view`, every export audited |
| Adjust the stock of a variant (receipt, write-off, stocktake) | `stock.adjust` | `adjustStockAction` (`actions/admin-stock.ts`): refuses a result below the reserved quantity (Q44), a request id makes a repeat harmless, the history row and the audit entry are written in the same transaction |

## Authentication facts

- Passwords: argon2id (19 MiB, 2 passes, 1 lane), per-hash salt, parameters stored with the hash.
  12 to 128 characters, must not contain the part of the email before the `@`.
- Five wrong passwords or TOTP codes in a row lock the account for 15 minutes (database time).
  A refusal never says whether the account exists, is locked or inactive; an unknown account still
  spends one password hash. Per-account serialisation is a transaction advisory lock, so a burst of
  parallel guesses cannot out-run the counter. A per-client limit sits in `proxy.ts` (30 a minute on
  the credential pages, 600 a minute over all clients) and again in the actions.
- TOTP secrets are AES-256-GCM encrypted at rest with the user id as associated data (a copied
  ciphertext does not decrypt in another account); keys are derived (HKDF) from `AUTH_SECRET`, one
  per purpose (session, totp, recovery). A code is good once (`last_used_step`). Recovery codes (80 bits) are shown once, stored
  as HMAC-SHA256 under their own key, single use.
- A password-only session is PENDING (10 minutes) and opens only the TOTP page; completing the
  second step issues a NEW session (the pending one is revoked: no fixation).
- Cookie `admin_session`: HttpOnly, SameSite=Strict, Secure outside local, `Path=/admin` (the browser
  never sends it to the storefront). The same token is accepted as `Authorization: Bearer` (mobile).
- `AUTH_SECRET` is required in production and must be at least 32 characters; without it nothing logs
  in and nothing resolves (fails closed).
- `audit_log` rows redact any key that looks like a credential (`password`, `secret`, `token`,
  `hash`, `code`, `key`, `cookie`, `authorization`). Authentication events are audited without the
  email or any secret.

## Catalog data and the cost

`products.cost_price` is read for the admin only through `packages/core/src/catalog-admin/read.ts`,
which serialises through `@store/shared/dto/admin-catalog`: a role without `catalog.cost.view` gets
a schema in which the key does not exist (zod drops unknown keys), so the value cannot leave the
server even though the row carries it. A cost change is written to `audit_log` as
`"costPrice": "changed"`, never with the old or new value. The serialized response is tested per
role: `packages/core/test/catalog-admin.int.test.ts` (JSON of the DTO) and `scripts/smoke-admin.ts`
(the real pages and the direct POSTs of a content role and a manager).

## Cache invalidation (owner queue Q23)

There is NO HTTP endpoint that invalidates the storefront cache. A catalog action returns the tags
to drop; `catalogAction` calls `revalidateTag(tag, 'max')` after the transaction committed and the
role was checked (`lib/admin/invalidate.ts`). A product edit drops `product:{id}`, the listing tag
of its category chain and the showcase, nothing else.

## Operating the lockout, and what the design does not cover

- **Locked out?** Five wrong passwords or codes lock an account for 15 minutes, and an attacker who
  knows the email can renew that lock (a known trade-off of per-account lockout). The recovery is
  `pnpm admin:unlock --email=...`, run by the owner on the server (audited as `auth.unlocked`).
  A per-address component and a second-owner unlock are queued (Q43).
- **Every page and action checks the session itself.** The shell layout calls `requireFullSession`,
  but Next renders a page in parallel with its layout, so a page must never rely on the layout
  having run: every page under `app/admin` calls `requireFullSession()` and every mutation goes
  through `adminAction`.
- **TOTP enrolment is first come.** An owner or admin who has not enrolled yet can be enrolled by
  whoever holds the password first. Create the account, then enrol at once (Q40).
- **Credential work is bounded.** At most 3 password hashes or TOTP transactions run at once and 6
  wait; more are refused at once ("too many attempts"), so a login flood cannot starve the site.
  The cap over all clients counts credential attempts (POST), not page loads.

## Uploads

A photo is megabytes, and `proxy.ts` buffers the body of every request it handles (64 KB cap), so the
upload route is excluded from the proxy's matcher and does everything itself, in this order, before it
reads a byte of the body: Origin (CSRF), a full admin session from the database, the `media.upload`
permission, a per-client and a per-user limit. Then: the declared length, then the size cap (12 MB)
enforced WHILE the body streams (a missing or false length cannot get past it), the type from the
BYTES (JPEG, PNG or WebP only: an SVG, an HTML page or a GIF sent as `image/jpeg` is refused, 415), the
pixel cap (40 MP, checked from the header before decoding: a decompression bomb is refused, not
decoded), no animation, EXIF orientation applied and all metadata (EXIF, GPS) stripped, never enlarged, the source decoded ONCE down to a 1600 px master from which every rendition is made (a JPEG is shrunk while it loads),
at most 2 uploads in flight over everybody and 1 per user (a slot is taken BEFORE the body is read and held to the end, the rest get 429 at once: this is what bounds memory), the body streamed into ONE buffer allocated from its declared length under a read deadline (15 s without data, 60 s in total: 408, the slot is released), the product and the photo count checked before the conversion. Storage keys are `products/<product id>/<image id>/<size>.<format>`:
ids and fixed words, never a file name (`assertSafeKey` refuses anything else). The row and its audit
entry are written in one transaction after the files are stored; a failure removes the files again.
The row, its order number and the 30-photo cap are decided under a per-product advisory lock. Files whose removal fails after a failed write stay in the bucket as ORPHANS (nothing references them; there is no sweeper and the storage client has no list call); every such case and every storage failure is logged at warn level with the object key prefix and a status only (owner queue Q47). Because the route bypasses the proxy it does not get the staging basic-auth gate: it answers 401
without an admin session, and every response is `private, no-store`.
## Import and export

CSV only (XLSX needs a library: owner queue). The parser is bounded (2 MB, 1000 rows, 30 columns,
20 000 characters a cell) and a file goes through a server action, so `proxy.ts`'s 64 KB body
limit applies, and it is a limit in BYTES (the screen and the action check UTF-8 bytes, 56 000): about 250 rows per file. An import is PREVIEWED first (every row validated, nothing
written), then committed; each row is written in its own savepoint through the same domain
functions as the editor, so one bad row never undoes the good ones and every rule (unique slug and
SKU, old price over price, 301 on a renamed slug) holds. An empty cell on an update changes
nothing. The export neutralises formulas (a cell starting with `=`, `+`, `-`, `@`, tab or CR gets
a leading apostrophe, removed again when the same file is imported) and reads the cost into the file only for a role that may see it. A file with a NUL byte, invalid UTF-8 or a repeated header is refused whole. A catalogue larger than one file (10 000 rows) is exported in parts (`?after=<sku>`; the screen lists them and a cut file answers `X-Export-Truncated`).

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
