CREATE TABLE "stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"variant_id" uuid NOT NULL,
	"user_id" uuid,
	"reason" varchar(20) NOT NULL,
	"delta" integer NOT NULL,
	"quantity_before" integer NOT NULL,
	"quantity_after" integer NOT NULL,
	"note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustments_reason" CHECK ("stock_adjustments"."reason" IN ('receipt', 'writeoff', 'stocktake', 'correction', 'import')),
	CONSTRAINT "stock_adjustments_adds_up" CHECK ("stock_adjustments"."quantity_after" = "stock_adjustments"."quantity_before" + "stock_adjustments"."delta"),
	CONSTRAINT "stock_adjustments_nonneg" CHECK ("stock_adjustments"."quantity_before" >= 0 AND "stock_adjustments"."quantity_after" >= 0),
	CONSTRAINT "stock_adjustments_delta_nonzero" CHECK ("stock_adjustments"."delta" <> 0)
);
--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_adjustments_variant_idx" ON "stock_adjustments" USING btree ("variant_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_adjustments_created_idx" ON "stock_adjustments" USING btree ("created_at");