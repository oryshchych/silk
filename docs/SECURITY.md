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
| `dictionaries.edit` | owner, admin | Edit the texts of a category (SEO text, description, search snippet) | `categories.edit` | `updateCategoryContentAction` (`actions/admin-taxonomy.ts`) from `/admin/categories/<id>` (`requirePermission('categories.edit')`): the SEO text is plain paragraphs or HTML, escaped or sanitised on write (`categoryTextToHtml`) and sanitised again on render |
| Colours, sizes, attributes and their values |
| `catalog.price` | owner, admin | Price, old price, promo price of products and variants |
| `catalog.cost.view` | owner, admin | See `cost_price` / `unit_cost_snapshot` anywhere (screens, exports) |
| `catalog.publish` | owner, admin, content | Publish or unpublish a product |
| `stock.adjust` | owner, admin, manager | Change the stock of a variant (with history) |
| `orders.view` | owner, admin, manager | Open the order list and an order card (no unit cost, no carrier cost without `catalog.cost.view`) |
| `orders.manage` | owner, admin, manager | Move an order along (confirm, including cash on delivery, process, ship, deliver) and write an internal note |
| `orders.cancel` | owner, admin, manager | Cancel an order (a comment is required) |
| `orders.edit` | owner, admin, manager | Change a quantity or take a line off an order that has not shipped (totals recomputed, reservation adjusted, history row with the reason) |
| `orders.refund` | owner, admin | Start a refund through the payment provider (full or part); money leaves only through the provider call |
| `orders.waybill` | owner, admin, manager | Create a Nova Poshta waybill, close an unknown one by hand, print the waybill and its sticker |
| `orders.export` | owner, admin | Download the orders CSV for the accountant (no email, phone or cost; every download audited) |
| `customers.view` | owner, admin, manager | Open the customer list and a customer card (name, email, phone, orders, sizes; no cost) |
| `customers.manage` | owner, admin, manager | Set a customer's tags and internal note |
| `customers.export` | owner, admin | Download the customers CSV (email and phone: personal data; every download audited) |
| `returns.manage` | owner, admin, manager | Read return requests (with the customer's e-mail), approve, refuse, record the physical receipt (the ONLY step that puts units back on the shelf) and close a return without a refund; the refund itself needs `orders.refund` |
| `reviews.moderate` | owner, admin, content | Read customer reviews (text, rating, size, fit: never the reviewer's e-mail, so the `content` role sees no customer data), approve, refuse and reply; every decision recomputes the product's rating and fit counters and is audited |
| `orders.confirm_payment` | owner, admin, manager | Record a received bank transfer (the confirmed source of a transfer payment, ADR-4) |
| `legal.edit` | owner, admin, content | Read and write DRAFT legal documents (terms, privacy, delivery and payment, returns, about, FAQ, contacts): the text and the PDF. A draft is never public |
| `legal.publish` | owner, admin | Publish a draft (it becomes immutable and public from its start time) and delete a draft. `content` drafts but cannot publish: a legal text going live is a decision with legal weight |
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
| Preview and commit a CSV import | `catalog.import` | `POST /admin/upload/products-csv?mode=preview` or `commit` (`app/admin/upload/products-csv/route.ts`): its own route like the photo upload (the proxy's 64 KB body limit is why), see "Uploads" below; it runs `previewImport` (writes nothing) and `commitImport` (`lib/admin/csv-import.ts`) through `adminAction`: a column the role may not write (price without `catalog.price`, cost without `catalog.cost.view`) turns the row into an error; each written row has its own audit row |
| Download the content template | `catalog.import` | `GET /admin/export/content-template`: a header and one example row the import refuses (`EXAMPLE-` SKU); no database read |
| Read the content readiness report (what is missing before launch) | `admin.view` | `/admin/content-readiness` (`requirePermission`); `readContentReadiness` takes a `Reader`, its DTO (`dto/content-readiness.ts`) has no cost, price or customer field in any shape, so every role gets the same shape; `private, no-store` and `noindex` from the admin proxy; staff text is escaped by React; the CLI form (`pnpm content:check`) runs in a `READ ONLY` transaction, takes the URL only from the environment and refuses a production-looking database outside a production process |
| Count a product page view | none (public, anonymous) | `POST /api/pv` (`app/api/pv/route.ts`): same-site `Origin`, 256-byte body cap, 60 a minute per client and 300 a minute in total, an empty 204 for any well-formed request (400, 403, 413 or 429 otherwise), a hash under a key derived from the server secret and no address stored, caps spent only by rows really written; see `docs/PRODUCT_VIEWS.md` |
| Download the product CSV | `catalog.export` | `GET /admin/export/products` (`app/admin/export/products/route.ts`): the cost column only for `catalog.cost.view`, every export audited |
| Change a quantity or take a line off an unshipped order | `orders.edit` | `editOrderItemsAction`: refused while an online payment is open, after a fiscal receipt, and for a shipped or cancelled order; the audit row records the lines that really changed |
| Refund (full or part) | `orders.refund` | `refundOrderAction`: the amount is reserved and audited in one transaction, the provider is called after the commit; a client request id makes a double submit of a partial refund one refund |
| Create an account, change a role, deactivate or activate, reset a password | `users.manage` (owner only) | `createUserAction`, `changeUserRoleAction`, `setUserActiveAction`, `resetUserPasswordAction` (`actions/admin-users.ts`, rules in `core/auth/users-admin.ts`): nobody changes their OWN account here, the last active owner cannot be demoted or deactivated (one advisory lock serialises two owners demoting each other), a role change, a deactivation and a password reset end every session of that person, a password is never audited, returned or stored in clear |
| Withdraw an unsent refund; confirm a refund whose answer is unknown | `orders.refund` | `withdrawRefundAction` (only `pending`), `resolveRefundAction` (only `in_flight` or `unknown`, the outcome and where it was checked are the person's, audited with the author); the worker sweep (`refunds.sweep`) sends an unsent one and only ALERTS on an unknown one, it never guesses |
| Adjust the stock of a variant (receipt, write-off, stocktake) | `stock.adjust` | `adjustStockAction` (`actions/admin-stock.ts`): refuses a result below the reserved quantity (Q44), a request id makes a repeat harmless, the history row and the audit entry are written in the same transaction |

The order card lists the email of the staff member behind each history row (note, status change, item edit) to every role that holds `orders.view`; like the stock history it never leaves the admin.

The reservation list on a variant's stock history page (the orders that hold the reserved quantity) is order data: a role without `orders.view` (content) receives only the reserved QUANTITY, the orders are not read for it.

The stock history lists the author's email next to every change, to every role that can open the admin (`admin.view`, content included): staff see who counted or wrote off stock. It is not exposed outside the admin. A replayed request id or a stocktake to the current quantity writes no second audit row: the audit log records a change once.

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

## Customer accounts (phase 7)

A customer is NOT an admin: `admin_users` has no row for them, and the two audiences never mix.

- **Registration** starts with an address only. The mailed link opens a page where the PERSON sets the
  password, so someone who types another person's address cannot choose the password of the account that
  person verifies later. The address counts as verified when the link is used; only then are the guest
  orders placed with that address claimed (`claimGuestOrders`: `lower(customer_email)` equals the verified
  address, `customer_id IS NULL`), never on a typed claim.
- **No enumeration.** Register, forgot-password and sign-in answer the same for a new address, an existing
  one, an admin and garbage; an unknown account still spends one password hash; the mail cap per account
  (3 an hour per purpose) is silent. A throttled client does see "too many attempts" (that depends on the
  client, not the address).
- **Links.** `<token row id>.<HMAC(id)>` under an HKDF key from `AUTH_SECRET`; nothing that works as a
  credential is stored or queued (the outbox payload is the row id only). Single use (one conditional
  UPDATE: two parallel uses have one winner), 24 hours for verification, 1 hour for reset; asking again
  replaces the older links. Opening the link page changes nothing (a mail scanner may fetch it); the POST
  uses it. The page sends no referrer.
- **Sessions.** Same design as the admin (ADR-19) with two walls: `auth_sessions.audience = 'customer'`
  (the admin lookup filters on `'admin'`) and a token signed under its own key (`customer-session`). The
  account, its verified address and the revocation are read from the database on every request. 14 days,
  fixed. A password reset ends every customer session of the account.
- **Cookie `customer_session`**: HttpOnly, SameSite=Lax (the link in a mail must open the account signed
  in), Secure outside local, `Path=/`. No storefront page reads it (the header link is static), so the
  public pages stay one cached copy for everyone. Every mutation also checks `Origin`.
- **Lockout** is the admin's: five wrong passwords lock the account for 15 minutes, one advisory lock per
  account serialises attempts.
- **Limits.** `proxy.ts` limits `/account/*` (30 a minute per client on the credential pages, 600 over all
  clients; 300 on the rest), every method but OPTIONS, every spelling (`/%61ccount`, `/en/account`); the
  actions repeat a per-client limit. Every response under `/account` is `private, no-store`, noindex,
  `Referrer-Policy: no-referrer`.
- **Timing.** The branches that send nothing (unknown address, an admin, a throttled one) do the same
  database work as the one that sends (lock, count, a queue insert rolled back with a savepoint), so the
  request time does not say which branch ran; a test bounds the median ratio of the cases.
- **Cookie name.** `__Host-customer_session` when `Secure` (the browser pins `Path=/`, no `Domain`: a
  sibling subdomain cannot plant or shadow it); the plain name only on a local http server.
- **Secrets.** Account security rests on `AUTH_SECRET` and its derived key purposes `customer-session` and
  `email-token`. Rotating `AUTH_SECRET` ends every customer session and kills every outstanding link.
- **Sessions.** 14 days absolute, no idle timeout, and a sign-in does not revoke the browser's earlier
  session (both are on purpose for a shop; a reset and a sign-out do end sessions).
- **Accepted risk (Q67).** The cap over ALL clients on the credential pages (600 a minute) can be filled
  by an attacker with enough addresses, which locks every customer out of those forms for the minute; and
  five wrong passwords lock a KNOWN account for 15 minutes, so anyone can lock a known account. A warning
  is logged when the cap passes half. The hardening phase replaces the lockout with throttling keyed by
  the target account and adds a proof-of-work or CAPTCHA step above half the cap.
- **Ownership.** Every account query is scoped by the customer id of the SESSION, never by an id from the
  request; a customer who names another customer's order, address or review gets the same "not found" as
  for a record that does not exist.

### Customer data and actions

Every customer action goes through `customerAction` (`apps/web/src/lib/account/action.ts`), in this order:
Origin (CSRF), the session read from the database, the per-customer limit (60 a minute), then the input is
parsed; the body runs in a transaction with the account as the author. A request without a session is
refused before its body is read.

| Action | Checked in |
|---|---|
| Reorder an order | `reorderAction`: the order is looked up by number AND the session's customer id; another customer's number is "not found"; the price and stock are the cart's and checkout's, never the old order's |
| Edit the profile (names, phone, language) | `updateProfileAction`; the audit row names the fields, never the values |
| Save sizes | `saveSizesAction`; a size of the wrong system is refused; the browser gets only the labels in the readable `silk_sizes` cookie |
| Newsletter on or off | `setNewsletterAction`; the consent row (`newsletter_subscribers`) records the time and the source `account`; a repeat records nothing; the history is in `audit_log` |
| Review a product I bought | `submitReviewAction`; the purchase is decided in the database from MY orders (not cancelled or returned; shipped, delivered or paid), the size is copied from the order line, one per product, five a day; the text is stored as plain text and shown escaped; the review is PENDING and absent from every cached page until a moderator approves it |
| Ask for a return | `requestReturnAction`; my order only (another number is "not found"), DELIVERED, inside the window on the database clock, units capped by what was ordered minus non-refused requests, counted under the order and line locks (ADR-22); it changes NO stock and NO money |
| Add or delete an address | `addAddressAction`, `deleteAddressAction`; an id of another customer is "not found"; ten at most (a per-customer lock), one default |

"Your size" on a product page never touches the cached HTML: the saved size travels in the `silk_sizes`
cookie (a label, not a secret) and a client component reads it after hydration. A smoke check compares the
product page byte for byte for an anonymous and a signed-in visitor.

### Returns and reviews (admin)

- **Stock moves in one place.** `receiveReturn` (permission `returns.manage`) is the only step that adds units back (ADR-18 "receive
  return"): a conditional UPDATE of the line's received quantity, ONE atomic `stock_quantity + delta`, a `stock_adjustments` row (reason
  `return`), all in one transaction under the per-return advisory lock, then the order (3), lines (4) and variants (8) via
  `acquireLocks`. A repeat of the same total, or a parallel call, applies the difference once. Approving or refusing never touches stock.
- **Money moves through the phase 5 flow.** `reserveReturnRefund` (needs `orders.refund` AND `returns.manage`) only after the receipt, and
  the amount is decided on the server from what was RECEIVED: `min(the amount agreed at approval, prorate(line total, received units))`
  with cumulative proration per order line (several partial returns add up to exactly the line total). At most one LIVE operation per
  return (claim under the lock, a composite key tying it to the same order, a partial unique index on each side); a FAILED refund is
  released and may be retried with a new request id, one that is pending, in flight, unknown or succeeded blocks a new one; the order's
  refund budget still bounds the money. The provider is called after the commit. The return becomes "refunded" only when the operation
  SUCCEEDED, by the refund action or the worker's sweep, with an audit row (`return.refunded`); the admin page only reads. A receipt
  is refused once a refund is linked, and an approval cannot grant more than the returned units are worth (a goodwill amount is a manual
  refund on the order).
- **Reviews:** `reviews.moderate` approves, refuses and replies; every decision recomputes the product's rating and fit counters from the
  approved rows in the same transaction and drops the product's cached page after the commit; the audit rows name the decision, never the text.
  `AggregateRating` markup is emitted only when the page shows approved reviews, with the same count (a smoke check compares them).

### Legal documents (phase 8)

- **Versions are history.** A published version is immutable and never deleted: the database refuses an `UPDATE` of its text, dates or
  identity and any `DELETE` (trigger `legal_documents_guard`, migration 0021). A correction is a NEW version. Return requests and recorded
  acceptances store a reference (`kind/locale/version`) to the text a person agreed to, so that text must stay.
- **Every column of a published row is protected** (migration 0022 compares `to_jsonb(NEW) - 'updated_at'` with the old row, so a column added
  later is covered too); each refusal is SQLSTATE `23514` with a stable constraint name (`legal_documents_guard_immutable`, `_status`, `_delete`,
  `_truncate`, `_past_start`). A version cannot be published with a start in the past by direct SQL either.
- **A later start cannot be overridden.** Publishing is refused (`LEGAL_START_TOO_EARLY`) when a published version of the same document already
  starts later, because the older text would silently become current again on that date and a published row cannot be taken back. A start is
  bounded to one year ahead (a year typo is permanent once published).
- **The current version is chosen by the database clock** (`effective_from <= now()`, latest wins, `status = 'published'`). A draft and a
  version scheduled for the future are never served. A publish never starts in the past (`greatest(effective_from, now())`).
- **Rich text is Markdown the editor types, rendered by `markdownToHtml` (every source character escaped first) and run through the
  allowlist `sanitizeHtml` on WRITE (the stored html) and again on EVERY READ.** Allowed: p, h2 to h4, ul, ol, li, strong, em, b, i, br, hr,
  blockquote and `a` with a vetted `href` (https, http, mailto, tel or a site path; `rel="noopener noreferrer"`). Scripts, event handlers,
  styles, iframes, forms, `javascript:` and `data:` URLs, and unknown tags never survive; the XSS corpus is in
  `packages/shared/src/rich-text.unit.test.ts`.
- **PDF upload** (`POST /admin/upload/legal-pdf`, `legal.edit`): the type is read from the bytes (`%PDF-`), 8 MB cap enforced while the body
  streams, the object key is built from ids, the object is stored with `Content-Type: application/pdf` and
  `Content-Disposition: attachment` (it downloads, it never renders inline) and `Cache-Control: private, no-store`. A DRAFT's PDF sits on the public media host
  under an unguessable key (uuid v4); it is removed from the store when the draft is deleted, when the file is removed and when it is replaced. Q76 is a
  release gate for this feature: the host rules (`nosniff`, no public listing) must be in place before a PDF is published. `X-Content-Type-Options: nosniff` is a response header of the
  media host (a Cloudflare transform rule, owner queue Q76): the object store cannot store it.
- **Every change is audited** (`legal.created`, `legal.updated`, `legal.file_set`, `legal.published`, `legal.draft_deleted`); the diff names
  the kind, locale and version, never the text.
- **Placeholder company data** (legal name, tax id, address) comes from `settings.company` and is shown as an explicit "not set" marker until
  the owner fills it in; it is never put into structured data.

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

CSV only (XLSX needs a library: owner queue Q46). The parser is bounded (2 MB, 1000 rows, 30 columns,
20 000 characters a cell). A file goes through its OWN ROUTE, `POST /admin/upload/products-csv`, not a
server action, because `proxy.ts` buffers every body it handles (64 KB: about 25 rows once the texts are in);
the route is under `admin/upload/`, which the proxy's matcher skips, and it does what the photo route does,
in the same order and BEFORE a byte of the body is read: a per-client limit, the content type (`text/csv`
or `text/plain`, 415 otherwise), Origin (CSRF), a full session from the database, the `catalog.import`
permission, a per-user limit. Then ONE in-flight slot over everybody (429 `BUSY`, held to the end: a commit
is a long transaction), the 2 MB cap enforced WHILE the body streams (413) and a read deadline (408), strict
UTF-8 (422), and the same `adminAction` as before (all its checks and the audit again). The columns are the
ones of `CONTENT_COLUMNS`; the template download carries one example row whose SKU the import refuses. An import is PREVIEWED first (every row validated, nothing
written), then committed; each row is written in its own savepoint through the same domain
functions as the editor, so one bad row never undoes the good ones and every rule (unique slug and
SKU, old price over price, 301 on a renamed slug) holds. An empty cell on an update changes
nothing. The export neutralises formulas (a cell starting with `=`, `+`, `-`, `@`, tab or CR gets
a leading apostrophe, removed again when the same file is imported) and reads the cost into the file only for a role that may see it. A file with a NUL byte, invalid UTF-8 or a repeated header is refused whole. A catalogue larger than one file (10 000 rows) is exported in parts (`?after=<sku>`; the screen lists them and a cut file answers `X-Export-Truncated`).

## Exports (orders and customers CSV)

Both routes check the session, the permission and a per-user limit (a 429 carries `Retry-After`) before anything is read. The columns are fixed in code (the audit row lists the range, the row count and whether the file was cut, not the columns). The audit row is written BEFORE the response is sent, so a download the browser aborts is still audited. Money cells are two-decimal text that a sheet reads as numbers, a phone is written as it is, and any other cell that starts with `=`, `+`, `-` or `@` (also after blanks) gets a leading apostrophe. A file is cut at 10 000 rows: its last line is `# truncated: next part starts after <cursor>`, so a person who only opens the file sees it, and the next download starts after that cursor (`after=`).

## Responses

- Every admin response carries `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`
  (`proxy.ts` and `next.config.ts`, for every spelling of the path).
- The admin has its own root layout; its theme attribute exists nowhere in storefront HTML.
- Data for the browser goes through explicit DTOs (`toAdminSessionDto`: email, role, permissions;
  never the session row).

## Known gaps (owner queue)

- **No forced password change** (owner queue Q55). An account the owner creates or resets keeps the password the owner typed until its holder asks for another one, and the owner knows it meanwhile. The Users screen and `pnpm admin:create` are the ONLY ways to set a password. Default: a later migration (`must_change_password`) and a change-password screen with the Q43 hardening PR. The password policy is a 12-character minimum plus the email-name check (no common-password list): also asked in Q55.
- Reactivating an account keeps its old authenticator (TOTP) and does not clear a lockout; a password reset clears the lockout and ends every session.

- Mobile refresh-token rotation (the bearer token works, refresh rotation needs its own table).
- Password reset by email and TOTP re-enrolment: not built. The owner resets another person's password on the Users screen (phase 5, Q41); the owner's own password is reset with `pnpm admin:create`.
- QR code for enrolment: the key and the `otpauth` link are shown as text.
