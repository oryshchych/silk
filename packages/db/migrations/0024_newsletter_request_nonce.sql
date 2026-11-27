-- Phase 11 (newsletter): the confirmation link is bound to a request generation, and one mailbox has one spelling.
--
-- 1. Rows that differ only by case are merged (the OLDEST row of a mailbox is kept) and every address is lower-cased,
--    BEFORE the CHECK that forbids upper case: the only writer so far (the account page) lower-cases already, so this
--    is normally a no-op, but a hand-made row must not make the migration fail.
-- 2. `request_nonce` is added with a volatile default: Postgres rewrites the table once and gives every existing row its
--    own value. The table is small (newsletter sign-ups); on a large table this would be a blocking rewrite.
DELETE FROM "newsletter_subscribers" a USING "newsletter_subscribers" b
  WHERE lower(a."email") = lower(b."email") AND (a."created_at", a."id") > (b."created_at", b."id");--> statement-breakpoint
UPDATE "newsletter_subscribers" SET "email" = lower("email") WHERE "email" <> lower("email");--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ADD COLUMN "request_nonce" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ADD COLUMN "confirm_mail_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ADD CONSTRAINT "newsletter_email_lower" CHECK ("newsletter_subscribers"."email" = lower("newsletter_subscribers"."email"));
