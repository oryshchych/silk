-- 0007's composite FKs are MATCH SIMPLE, so they are skipped while order_id is
-- NULL. An event or gift card transaction that names a payment attempt must
-- also name the order, otherwise the same-order proof does not apply.
ALTER TABLE payment_events
  ADD CONSTRAINT payment_events_attempt_needs_order
  CHECK (payment_attempt_id IS NULL OR order_id IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE payment_events VALIDATE CONSTRAINT payment_events_attempt_needs_order;--> statement-breakpoint
ALTER TABLE gift_card_transactions
  ADD CONSTRAINT gift_card_txn_attempt_needs_order
  CHECK (payment_attempt_id IS NULL OR order_id IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE gift_card_transactions VALIDATE CONSTRAINT gift_card_txn_attempt_needs_order;
