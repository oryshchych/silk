ALTER TABLE "stock_adjustments" DROP CONSTRAINT "stock_adjustments_reason";--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "return_requests" ADD COLUMN "refund_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_refund_operation_id_refund_operations_id_fk" FOREIGN KEY ("refund_operation_id") REFERENCES "public"."refund_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "return_requests_refund_op_uq" ON "return_requests" USING btree ("refund_operation_id") WHERE "return_requests"."refund_operation_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_refund_nonneg" CHECK ("return_requests"."refund_amount" IS NULL OR "return_requests"."refund_amount" >= 0);--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_reason" CHECK ("stock_adjustments"."reason" IN ('receipt', 'writeoff', 'stocktake', 'correction', 'import', 'return'));