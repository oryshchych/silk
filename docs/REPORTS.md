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
Open choices: Q85, Q86.

## Performance

`pnpm db:seed-synthetic [orders]` writes a deterministic synthetic history (default 50 000 orders) into a
local EMPTY database (refused in production, on a non-local host, on a database with orders).
`reports-perf.int.test.ts` runs every report on it in a read-only transaction and fails over a 3 s CI
bound (target 1 s); it prints the real timings. No materialised view was needed (Q87).

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
