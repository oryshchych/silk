-- Phase 10 reports read money by the time of its own operation. Partial indexes on exactly the filtered rows,
-- so a one-month window reads a range instead of the whole table. Plain CREATE INDEX (a migration runs in
-- a transaction): the tables are small until launch; on a big live table build them CONCURRENTLY by hand first.
CREATE INDEX "orders_cancelled_at_idx" ON "orders" USING btree ("cancelled_at") WHERE "orders"."cancelled_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_attempts_captured_at_idx" ON "payment_attempts" USING btree ("completed_at") WHERE "payment_attempts"."captured_amount" > 0;--> statement-breakpoint
CREATE INDEX "refund_settled_at_idx" ON "refund_operations" USING btree ("settled_at") WHERE "refund_operations"."state" = 'succeeded';--> statement-breakpoint
CREATE INDEX "return_requests_received_at_idx" ON "return_requests" USING btree ("received_at") WHERE "return_requests"."received_at" IS NOT NULL;