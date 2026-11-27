# Reports: what every figure means (phase 10)

Read-only SQL in `packages/core/src/reports`. Every amount is an integer count of kopiykas; percentages
are integer basis points (1 % = 100); nothing is a float. Periods are inclusive ranges of SHOP days
(Europe/Kyiv); the database decides the boundaries (`AT TIME ZONE`), so a 23-hour spring day and a
25-hour autumn day are right and the app server's clock is never consulted.

## Revenue: three figures from the payment journal

| Figure | Source | Dated by |
|---|---|---|
| Gross receipts | `payment_attempts.captured_amount` (> 0) | `completed_at`, the capture time |
| Refunds | `refund_operations`, state `succeeded` | `settled_at` |
| Net receipts | gross minus refunds of the same period | |

Never derived from order status: an order partly refunded keeps its money in gross.

A refund settled in a LATER period lowers that later period; the earlier one is never rewritten.
Example: 500.00 UAH captured on 30 Sep 23:30 Kyiv, refunded on 2 Oct. September: gross 500.00, net
500.00. October: gross 0, refunds 500.00, net -500.00 (`reports-revenue.int.test.ts`).

What counts as captured, per method:

- Cards (mono, wayforpay): the confirmed `paid` result carries the captured amount.
- Bank transfer: `confirmTransferReceived` records a `bank_transfer` attempt for the received amount
  when the manager confirms the bank line.
- Cash on delivery: nothing. `confirmCodOrder` captures nothing and v1 cannot record the carrier's
  remittance, so a COD order is in no figure (owner queue Q85).
- Gift cards: not revenue when sold (`docs/GIFT_CARDS.md` section 0; v1 sells none), and a payment
  made with one is not a cash receipt: attempts and refunds of provider `gift_card` are excluded.

**Cash on delivery is shown, not counted.** `RevenueTotalsDto.codNotIncluded` gives the count and the total of COD
orders created in the period that the shop is fulfilling (confirmed, processing, shipped, delivered) and has not
refunded. It sits beside the three figures on every revenue report and is in none of them. Whatever the owner decides
in Q85 (keep zero until a remittance row exists, or book COD at delivery), this line stays, so "net receipts" is never
read as "all sales".

Dating, stated plainly: a card capture is dated by the moment the confirmed result was applied (`completed_at`), a bank
transfer by the moment the manager confirmed the bank line (not the bank's value date): a transfer that arrived on 31
January and was confirmed on 2 February counts in February. In a weekly series whose range starts mid-week, the first
bucket is labelled with the Monday before `from` and counts only in-range money.

Money rows with no time (a capture without `completed_at`, a succeeded refund without `settled_at`) belong
to no period; they are counted in `untimedCaptures` / `untimedRefunds` and must be zero.

## Comparison

Current period against the previous period of the same length (ending the day before `from`) and the same
dates one year earlier, only when the journal holds money events that old. The absolute change is always
given. The percentage is `null` when the previous value is zero; a fall to zero is exactly -100 %.

## Margin (cost roles only)

Event-dated like revenue. Sale: an order enters the period of its FIRST capture; each line with a
`unit_cost_snapshot` adds `line_total` and `cost x quantity`. A line without a snapshot is excluded and
counted (`noCostLines`), never treated as zero cost. A paid order cancelled later reverses its goods at
`cancelled_at`. A received return reverses, at its FIRST receipt, the received units' share of the line
revenue (rounded half up once) and the cost of the restocked units only (a defective unit keeps its
cost); a return received after its refund lowers the period of the receipt. The carrier cost
(`shipping_cost_actual`) counts only when `shipping_paid_by = 'sender'`; a seller-paid order without a
recorded cost is counted in `noShippingCostOrders`. Goodwill refunds (tied to neither a received return
nor a cancelled order) are shown as `otherRefunds`, outside the margin. Per-product and per-category
rows carry goods margin only and an "all other" row, so they add up to the total to the kopiyka.
A late payment on an order that was already cancelled gives a reversal dated before its sale (one period negative,
a later one positive; the total is right). The by-category rows group by the full category path recorded on the line
(`Bras` and `Bras/Push-up` are separate rows; there is no roll-up by root yet). Open choices: Q85, Q86.

## Performance

`pnpm db:seed-synthetic [orders]` writes a deterministic synthetic history (default 50 000 orders) into a
local EMPTY database (refused in production, on a non-local host, on a database with orders).
`reports-perf.int.test.ts` runs every report on it through `inReportTransaction` and fails over a 3 s CI bound (target
1 s); it prints the real timings. `REPORTS_PERF_ORDERS=200000` runs the same checks at four times the size (not in CI).

Measured on a laptop, cold (warm in brackets), whole 23 months of history:

| Report | 50 000 orders | 200 000 orders |
|---|---|---|
| revenue by month | 54 ms | 287 ms |
| margin totals | 140 ms | 1237 ms (1119) |
| margin by product | 224 ms | 1353 ms (1000) |
| margin by category | 183 ms | 1020 ms (1090) |

A one-month window at 200 000 orders: revenue 42 ms, margin totals 110 ms, margin by product 363 ms. Margin over the
WHOLE history at 200 000 orders is at the one-second target, not under it: its cost is the random reads of 310 000
order lines, which no index removes. Migration 0023 adds four partial indexes (captured payments by time, settled
refunds by time, returns by receipt, cancellations) so a window reads a range, and the margin query only examines
the orders a window touches. When whole-history margin on real data passes about 700 ms, add a materialised view
(owner queue Q87).

Every report runs in `inReportTransaction` (`reports/transaction.ts`): READ ONLY (a write is refused by Postgres),
repeatable read (one snapshot), its own `statement_timeout`, a recognisable `application_name`. The module exports
no raw reader (`exports.unit.test.ts`).

## The ten reports (slice B)

| Report | What it counts | Dated by |
|---|---|---|
| revenue | the three journal figures, by day, week or month | capture / settle time |
| orders | orders by status, delivery and payment method | creation day |
| top-products | units and ordered value of non-cancelled orders (NOT revenue) | creation day |
| margin (cost roles) | event-dated goods margin by product or category, plus carrier cost | events, see above |
| stock | variants with available stock up to a threshold; value at price, at cost for cost roles | now |
| returns | requests by reason, received, refunded; requests per paid order | request creation |
| promos | discount per code, share of orders with a code | creation day |
| customers | new vs returning by first capture; top 20 by lifetime net receipts (key only) | capture time |
| providers | attempts, succeeded, failed, success rate among settled, refunds | attempt creation, settle time |
| viewed-not-bought | products with views and no purchase in the period (a list) | view day (UTC) |

Every report is one `ReportResultDto` (`columns`, `rows`, a totals row over the whole period, facts, notes, an
optional chart). The screen and the CSV are two renderings of it. No funnel and nothing called conversion: views
and purchases are unlinked aggregates (plan, phase 10).

## Dashboard and alerts

`/admin` (for `reports.view`; a content editor sees the plain welcome) shows the key figures of the last 30 shop
days against the previous 30 days and the same dates a year earlier (only when the journal holds money that old):
gross, refunds, net, payments received, and, only for a role with `catalog.cost.view`, the margin. Each is the SAME
function as its report, so the dashboard and the report cannot disagree. The absolute change is always shown, the
percentage only when the earlier value is not zero (a fall to zero is exactly -100 %). The data time is on the page.
No materialised view exists, so nothing can be stale: each read is at most 60 s old (the shared computation).

Alerts (counts and the age of the oldest row, no row data), each with a read-only link where a screen resolves it:

| Alert | Counted when |
|---|---|
| outbox_stuck | an outbox row is unpublished for over 15 minutes (the relay is not delivering; no screen yet) |
| refund_open | a refund is still pending, in flight or unknown for over 10 minutes |
| payment_unknown | a payment attempt is in state `unknown` |
| reservation_expiring | an unreleased reservation expires within 15 minutes |
| low_stock | an active variant has 3 or fewer units available |
| fiscal_failed | an order's fiscal receipt is `failed` |
| waybill_unknown | a waybill operation is `unknown`, or pending or in flight for over 10 minutes |

The dead-letter queue lives in the pg-boss schema, which the app role does not read; the stuck-outbox count is the
visible symptom of it.

## Rules pinned by review (phase 10, slice B)

- **Orders report:** the amount column is ordered value of orders that are NOT cancelled (a cancelled row still counts the
  order and shows 0); it is not revenue.
- **Top products:** `orderedValue` is the ordered value of non-cancelled lines, not net of returns and including unpaid
  orders; it is not revenue.
- **Promo codes:** the discount is the sum of CONSUMED `promo_code_redemptions` of non-cancelled orders; a released
  redemption gave nothing. A code used on an order with another kind of discount is not credited with it.
- **Payment providers:** refunds are listed by the provider of the attempt behind them; a succeeded refund with no
  attempt is the explicit `unlinked` row, so the refund total equals the revenue report to the kopiyka. Dated by the settle
  time (a refund made in May and settled in June belongs to June).
- **Ranges:** a daily series (revenue by day) is capped at 366 days; every other report accepts up to about three years
  (1100 days); `granularity` means nothing to them.
- **Audit:** an export records `includedCost` from what the file holds (a cost column or fact), not from the role.
- **Alerts:** until the worker runs (owner queue Q31) every outbox row ages and the "stuck outbox" alert is permanent.
