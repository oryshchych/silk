DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "reviews" WHERE char_length(coalesce("body", '')) > 2000 OR char_length(coalesce("admin_reply", '')) > 2000) THEN
    RAISE EXCEPTION '0017: a review text is longer than 2000 characters; shorten it by hand before migrating'
      USING DETAIL = (SELECT string_agg("id"::text, ',') FROM "reviews" WHERE char_length(coalesce("body", '')) > 2000 OR char_length(coalesce("admin_reply", '')) > 2000);
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_not_both" CHECK (NOT ("reviews"."is_approved" AND "reviews"."rejected_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_text_length" CHECK (char_length(coalesce("reviews"."body", '')) <= 2000 AND char_length(coalesce("reviews"."admin_reply", '')) <= 2000);