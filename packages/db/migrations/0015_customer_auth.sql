DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "customers" WHERE "email" <> lower("email")) THEN
    RAISE EXCEPTION '0015: a customer email is not lower case; normalise it by hand before migrating'
      USING DETAIL = (SELECT string_agg("id"::text, ',') FROM "customers" WHERE "email" <> lower("email"));
  END IF;
END
$$;
--> statement-breakpoint
CREATE TYPE "public"."auth_token_purpose" AS ENUM('verify_email', 'reset_password');--> statement-breakpoint
CREATE TYPE "public"."session_audience" AS ENUM('admin', 'customer');--> statement-breakpoint
CREATE TABLE "auth_email_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "auth_token_purpose" NOT NULL,
	"locale" varchar(5) DEFAULT 'uk' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "audience" "session_audience" DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_email_tokens" ADD CONSTRAINT "auth_email_tokens_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_email_tokens_user_idx" ON "auth_email_tokens" USING btree ("user_id","purpose","created_at");--> statement-breakpoint
CREATE INDEX "orders_email_lower_idx" ON "orders" USING btree (lower("customer_email"));--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_email_lower" CHECK ("customers"."email" = lower("customers"."email"));