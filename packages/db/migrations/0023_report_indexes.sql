-- Phase 10 reports read money by the time of its own operation. Partial indexes on exactly the filtered rows,
-- so a one-month window reads a range instead of the whole table. A migration runs in a transaction, so these
-- are plain CREATE INDEX: the tables are small until launch. On a big live table build them CONCURRENTLY by
-- hand first; IF NOT EXISTS then lets this migration pass instead of rolling the whole run back. CAUTION: IF NOT
-- EXISTS also accepts an INVALID leftover of a failed concurrent build, so check first with
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- and drop any invalid one of these four before migrating.
CREATE INDEX IF NOT EXISTS "orders_cancelled_at_idx" ON "orders" USING btree ("cancelled_at") WHERE "orders"."cancelled_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_attempts_captured_at_idx" ON "payment_attempts" USING btree ("completed_at") WHERE "payment_attempts"."captured_amount" > 0;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refund_settled_at_idx" ON "refund_operations" USING btree ("settled_at") WHERE "refund_operations"."state" = 'succeeded';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_requests_received_at_idx" ON "return_requests" USING btree ("received_at") WHERE "return_requests"."received_at" IS NOT NULL;