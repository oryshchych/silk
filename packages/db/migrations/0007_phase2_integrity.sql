ALTER TABLE "order_status_history" DROP CONSTRAINT "order_status_history_order_id_orders_id_fk";
--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD COLUMN "quoted_total" integer;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intent_quote_nonneg" CHECK ("checkout_intents"."quoted_total" IS NULL OR "checkout_intents"."quoted_total" >= 0);--> statement-breakpoint

-- RR1: a payment attempt, a return request and an order must agree. The
-- composite FKs are MATCH SIMPLE (the default): they are not checked while any
-- column is NULL, which is right for the optional references. FKs are added
-- NOT VALID and validated in a second step (VALIDATE takes a weaker lock).

ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_id_order_uq
  UNIQUE (id, order_id);--> statement-breakpoint

ALTER TABLE payment_events
  ADD CONSTRAINT payment_events_attempt_same_order_fk
  FOREIGN KEY (payment_attempt_id, order_id)
  REFERENCES payment_attempts (id, order_id) ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE payment_events VALIDATE CONSTRAINT payment_events_attempt_same_order_fk;--> statement-breakpoint

ALTER TABLE refund_operations
  ADD CONSTRAINT refund_ops_attempt_same_order_fk
  FOREIGN KEY (payment_attempt_id, order_id)
  REFERENCES payment_attempts (id, order_id) ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE refund_operations VALIDATE CONSTRAINT refund_ops_attempt_same_order_fk;--> statement-breakpoint

ALTER TABLE gift_card_transactions
  ADD CONSTRAINT gift_card_txn_attempt_same_order_fk
  FOREIGN KEY (payment_attempt_id, order_id)
  REFERENCES payment_attempts (id, order_id) ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE gift_card_transactions VALIDATE CONSTRAINT gift_card_txn_attempt_same_order_fk;--> statement-breakpoint

-- refund_operations.return_request_id had no FK at all.
ALTER TABLE refund_operations
  ADD CONSTRAINT refund_ops_return_same_order_fk
  FOREIGN KEY (return_request_id, order_id)
  REFERENCES return_requests (id, order_id) ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE refund_operations VALIDATE CONSTRAINT refund_ops_return_same_order_fk;--> statement-breakpoint
CREATE INDEX refund_ops_return_idx ON refund_operations (return_request_id)
  WHERE return_request_id IS NOT NULL;--> statement-breakpoint

-- The order's current attempt must be one of ITS OWN attempts, and is never
-- silently cleared (was ON DELETE SET NULL on a simple FK).
ALTER TABLE orders DROP CONSTRAINT orders_current_attempt_fk;--> statement-breakpoint
ALTER TABLE orders
  ADD CONSTRAINT orders_current_attempt_fk
  FOREIGN KEY (current_payment_attempt_id, id)
  REFERENCES payment_attempts (id, order_id) ON DELETE RESTRICT NOT VALID;--> statement-breakpoint
ALTER TABLE orders VALIDATE CONSTRAINT orders_current_attempt_fk;--> statement-breakpoint

-- RR2: updated_at is maintained by the database on the six tables 0005 missed.
CREATE TRIGGER promo_codes_touch_updated_at BEFORE UPDATE ON promo_codes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
CREATE TRIGGER pages_touch_updated_at BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
CREATE TRIGGER blog_posts_touch_updated_at BEFORE UPDATE ON blog_posts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
CREATE TRIGGER return_requests_touch_updated_at BEFORE UPDATE ON return_requests
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
CREATE TRIGGER gift_cards_touch_updated_at BEFORE UPDATE ON gift_cards
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
CREATE TRIGGER settings_touch_updated_at BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
