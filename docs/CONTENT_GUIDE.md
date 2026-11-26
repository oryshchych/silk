# Content guide (phase 9)

For the person who fills the catalogue: 40 products in Ukrainian and English, photos, and a text for every
category. The agent built the tools; **the content itself is yours**. Nothing here is product copy and
nothing in the repository invents it. Where a screen label is Ukrainian it is given in brackets
(`Назва`), because the admin shows the Ukrainian label by default.

The numbers below are the ones the tools use. They live in one file,
`packages/shared/src/content-bounds.ts`, so this guide, the import preview, the readiness screen and
`pnpm content:check` cannot disagree. If a number here differs from that file, the file wins.

## 1. The short version

1. Make the categories and write their texts (section 5).
2. Add colours, sizes and attributes once (`/admin/dictionaries`).
3. Download the template (`/admin/import-export`), fill one row per product, upload it: preview first, then import (section 6). Products arrive as **drafts**.
4. Open each product: generate variants, set stock, upload photos with alt text in both languages (section 4).
5. Watch `/admin/content-readiness` until every active product and category is ready.
6. Publish. Then run the launch gate (section 8).

## 2. What each field means

Both languages are required for every text. Lengths are characters after trimming; invisible
characters (zero-width spaces, a lone non-breaking space) do not count, so they cannot make an empty
field look filled.

| Field (CSV column; screen label) | Where a visitor sees it | Bound | Notes |
|---|---|---|---|
| `name_uk`, `name_en` (`Назва`) | Product page heading, cards, cart, feed title | 3 to 120 | The real model name as on the label. Not marketing slogans. |
| `short_description_*` (`Короткий опис`) | Card text, feed description, fallback meta description | 20 to 300 | One or two plain sentences. |
| `description_*` (`Повний опис`) | Product page | 80 to 5000 | What the product is, fit, use. Only what you can verify. |
| `composition_*` (`Склад`) | Product page, feed | 3 to 500 | As on the label: "Cotton 95%, elastane 5%". |
| `care_*` (`Догляд`) | Product page | 3 to 500 | As on the label. |
| `meta_title_*` | `<title>` in search results and browser tabs | 20 to 46 | The shop name is added after it (" \| LACE & SILK", 14 characters), so 46 keeps the whole title under about 60. |
| `meta_description_*` | The snippet under the title in search | 70 to 160 | A sentence that makes someone click. Different from every other product's, and not the short description pasted again. |
| `brand` | Product page, feed brand | required | The brand as an attribute (the shop is a reseller). |
| `slug` | The address `/product/<slug>` | lowercase Latin words joined by hyphens | Changing it later leaves a 301 from the old one. |
| `category` | Breadcrumbs, listing | slug of an existing category | |
| `price`, `compare_at_price` | Product page, feed | positive; the old price must be higher | Only owner and admin may write prices. |

The database allows more than the bounds (for example a meta description up to 400): a text outside a bound is **reported**, never refused by the editor. Meta lengths outside a bound and a meta
title or description identical in both languages are blockers (section 7); other lengths are advice.

### Category texts (`/admin/categories`, then "Texts")

| Field | Bound | Notes |
|---|---|---|
| SEO text, Ukrainian and English | 200 to 5000 visible characters | Shown under the product list on the first page of the category without filters. Write plain paragraphs (a blank line starts a new one); HTML with `p`, `h2`, `h3`, `ul`, `ol`, `li`, `strong`, `em` and https links is also accepted and cleaned. |
| Description | up to 5000 | Short text under the heading. |
| Meta title, meta description | as for products | Optional: the page falls back to the category name. |

An indexable active category with no live products blocks the gate: switch an empty category off or mark it noindex.

## 3. SEO rules that the tools check, and the ones only you can keep

Checked by the machine:

- Both languages present, within the bounds above.
- No meta title or description copied between the languages (that would put the same snippet under both hreflang versions).
- Advice: no body text copied between languages; no meta text shared with another product; wording that needs a source (see below).
- Every photo has alt text in both languages; alt text is 5 to 125 characters (a placeholder like "." is a blocker).

Only you can keep:

- **Write each language, do not paste.** A Ukrainian text copied into the English field is worse than an empty one.
- **No claim you cannot prove.** Certifications (Oeko-Tex, GOTS), "hypoallergenic", "antibacterial", health or medical effects, superlatives. The tool flags these words as advice (`claim_review`): either keep a supplier document that proves the claim, or remove it. This also protects the Merchant Center listing.
- **Unique wording per product.** Two products with the same meta description compete with each other.
- **Alt text describes the photo**, in the page's language: "Black lace bra, front view", not "photo1" and not a keyword list. The first 125 characters are what a screen reader reads.
- **The facts in structured data come from the fields**, not from anywhere else: price, availability, brand, GTIN. A wrong barcode is worse than none.
- A product's barcode, if it has one, is entered on the variant as a valid GTIN (8, 12, 13 or 14 digits). Without it the feed still lists the product (brand and SKU are the identifier) and the report only advises.

## 4. Photos

| Rule | Value |
|---|---|
| Formats | JPEG, PNG, WebP (the type is read from the bytes; a renamed GIF or SVG is refused) |
| Size of the file | up to 12 MB |
| Pixels | up to 40 megapixels and 12 000 px on the longest side; no animation |
| Recommended | at least **1000 px wide**; shape between 2:3 (portrait) and 1:1 (square), the same shape for every photo of one product |
| Per product | up to 30; the first is the main photo and the card image |
| What the shop makes | WebP and AVIF at 320, 800 and 1600 px; metadata (EXIF, GPS) is removed |
| Colour | A photo can be tied to a colour in the product editor; picking that swatch then shows those photos first |
| Alt text | both languages, section 3 |

Prerequisites before the first upload works on staging: the media bucket and its keys (**Q45**), and the
header rules on the media domain (**Q76**, a release gate for legal PDFs; photos need Q45 only). Until
Q45 is done the upload answers "media is not configured".

The report lists, per photo, what is wrong: alt text missing or too short, narrower than 1000 px, outside the proportions, a missing rendition (the row exists but a file name is absent: upload it again), an unsafe address. It cannot tell a blurry photo from a sharp one, or find duplicates (no content hash is stored: queued as **Q82**).

## 5. The workflow in order

0. **Before you start**: an owner account on the server (**Q40**), and for photos the media bucket (**Q45**).
1. **Categories** (`/admin/categories`): create the tree; for each one open "Texts" and write the SEO text in both languages. A category that will stay empty at launch: switch it off.
2. **Dictionaries** (`/admin/dictionaries`): colours, sizes (bra band and cup, apparel sizes), attributes and their values.
3. **Template** (`/admin/import-export`, "Download the template"): the header the import understands plus one example row. The example row is refused by the import, so a file uploaded unchanged loads nothing.
4. **Fill** one row per product. Leave `price` as the real price (only owner and admin can change prices later). A cell you leave empty on an **update** changes nothing; on a **create** it stays empty and the preview says so.
5. **Upload**: the screen first shows a preview: every line, what will be created or updated, errors with the line number, and per line the content that will still be empty or outside the bounds. Fix and upload again; nothing is written until you press Import. One file may hold up to **2 MB and 1000 rows**; with full texts that is a few hundred products. Excel opens and saves the file (it keeps the BOM, accepts `;` as the separator); real `.xlsx` is queued (**Q46**).
6. **Round trip**: "Download CSV" exports every product with the same content columns, so you can export, edit in Excel and import again. Importing an unchanged export changes nothing.
7. **Per product** (`/admin/products/<id>`): generate variants (size x colour), set stock (`/admin/stock`), upload photos and write the alt text in both languages, link photos to colours, assign attributes.
8. **Watch** `/admin/content-readiness`: it lists, for every product and category, exactly what is missing, with a link to the editor. "Needs work" is the default view.
9. **Publish** each product (owner, admin and content may publish). It then appears on the storefront within a minute.
10. **Gate** (section 8).

## 6. The import columns

Basics: `sku` (required, unique), `slug`, `brand`, `category`, `name_uk`, `name_en`, `price`, `compare_at_price`, `cost_price` (owner and admin only), `weight_grams`.
Content (each with `_uk` and `_en`): `short_description`, `description`, `composition`, `care`, `meta_title`, `meta_description`.

A product is matched by `sku`. To **create**, these are required: `sku`, brand, category, both names, price. Columns the file does not have are listed in the preview ("not in the file"); unknown columns are listed and ignored. Variants, stock, photos, alt text and attributes are not in the CSV: they are entered in the editors (step 7).

A row whose SKU starts with `EXAMPLE-` is the template's example and is always refused.

## 7. What the readiness gate checks and how to read it

`/admin/content-readiness` (everyone who can open the admin) and `pnpm content:check` read the same report from the database.

A product is **live** when the storefront shows it (active, published, its categories visible). It is **ready** when nothing in the report is a **blocker**.

Blockers (the gate fails while any active product or active category has one):

- not published (no date or in the future), category hidden, slug that cannot be served, brand missing, price missing
- no active variant, no variant with stock, a variant SKU longer than 50 characters (the feed drops it)
- a text missing in either language (name, short description, description, composition, care, meta title, meta description)
- a meta title or description shorter or longer than its bound, or identical in both languages
- no photo, a photo without alt text in either language, alt text that is too short to be real, a photo with a missing rendition or an unsafe address
- an active product marked noindex (it would count as live but be excluded from search)
- a category without an SEO text in either language (a category marked noindex only gets advice), an indexable category with no live products

Everything else is **advice** and never fails the gate: body texts outside their length, the same body text in both languages, a meta text shared with another product, wording that needs a source, no attributes, a missing GTIN, a narrow or oddly shaped photo, alt text over 125 characters, a draft.

Several blockers are **quality rules, not broken pages**: the storefront has fallbacks and renders a sold-out or alt-less product correctly. They are blockers because the launch criteria say so.

The acceptance checks, in the order the screen shows them:

1. **Live products**: at least 40 are live **and ready** (the target is `--expected-active`, default 40).
2. **Variants, stock, photos**: no active product lacks them.
3. **Alt, meta description, photo**: no active product lacks a photo, an alt text or a meta description (the plan's wording).
4. **Category SEO text**: every active category has the text in both languages.
5. **No other blocker** anywhere among active products and categories.

The gate passes when all five hold. The report is counted once a minute for everybody ("Count again" refreshes it, at most every 5 seconds).

### The command line

```bash
DATABASE_URL=postgres://localhost/store pnpm content:check              # summary; exit 1 if the gate fails
DATABASE_URL=...  pnpm content:check --gate                             # verdict and counts only (the pre-launch form)
DATABASE_URL=...  pnpm content:check --json > report.json               # the full report; the summary goes to stderr
DATABASE_URL=<staging url> pnpm content:check --gate --allow-remote     # a database that is not local
```

Exit code 0 passed, 1 gate failed, 2 refused or could not run. `--expected-active=N` sets the target; `--report-only` always exits 0. The checker only reads (a read-only transaction), takes the URL only from the environment (never an argument), refuses a remote database unless you pass `--allow-remote`, and refuses a name that looks like production even then. It is **not** part of CI (an empty staging catalogue would fail every pull request): it is a manual step.

## 8. Launch checklist (the part that belongs to this phase)

- [ ] 40 products active and published, each ready (`/admin/content-readiness`: "40 of 40 live products are ready").
- [ ] `pnpm content:check --gate --allow-remote` against staging prints `GATE: PASS` (the owner runs it with the staging `DATABASE_URL`; the agent never holds that URL: **Q81**).
- [ ] Every active category has its SEO text in both languages and at least one live product.
- [ ] Look at five product pages and two category pages on staging in both languages: title, description, photo, alt text (view source), composition and care read well.
- [ ] Open `https://staging.damazla.com/feed/google.xml` and check a few items (image, price, availability, brand); then Q62 (Merchant Center and Meta feeds).
- [ ] The shop name is final (**Q1**): if it changed, update `TITLE_SUFFIX_RESERVE` (a test reminds you) and re-run the gate.
- [ ] Outside this phase but required before launch: legal texts (**Q77**, **Q80**), media header rules (**Q76**), the worker and e-mail (**Q31**, **Q63**).

## 9. Limits, honestly

- The tools cannot judge whether a text is good, true or well translated; they check that it exists, is not empty by trick, is within bounds, and is not obviously copied.
- Photo checks are by stored numbers and key names; the bucket itself is not listed (the storage client has no listing yet: **Q47**).
- Duplicate photos are not detected (no hash is stored: **Q82**).
- The CSV cannot carry variants, stock, photos or attributes.
