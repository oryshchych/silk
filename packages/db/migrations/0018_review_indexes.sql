DROP INDEX "reviews_pending_idx";--> statement-breakpoint
CREATE INDEX "reviews_customer_created_idx" ON "reviews" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "reviews_pending_idx" ON "reviews" USING btree ("created_at") WHERE "reviews"."is_approved" = false AND "reviews"."rejected_at" IS NULL;