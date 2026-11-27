-- Phase 11 (banners), review round: the CHECKs of 0025 were weaker than the rules the code states. 0025 is committed
-- and never edited, so the three constraints are replaced here:
--   href: the admin's Zod rule exactly (a path on this shop: no space, backslash, control character), at most 2000 characters;
--   an active banner has visible alt text in both languages (not just spaces);
--   a stored picture has a non-empty address and positive width and height.
-- Rows that would violate the new rules are brought inside them BEFORE the constraints are added (a bad picture is
-- cleared as a whole, a bad link cleared, an incomplete banner switched off), so the migration cannot fail on old data.
-- Snapshot `banners` before applying 0025 and 0026 on staging or production: both are forward-only and drop what they must.
-- The CHECKs are added without NOT VALID: the table is tiny. Do not copy this pattern to a large table (ACCESS EXCLUSIVE scan).
ALTER TABLE "banners" DROP CONSTRAINT "banners_href_internal";--> statement-breakpoint
ALTER TABLE "banners" DROP CONSTRAINT "banners_active_complete";--> statement-breakpoint
UPDATE "banners" SET "image_desktop_url" = NULL, "image_desktop_width" = NULL, "image_desktop_height" = NULL
  WHERE "image_desktop_url" IS NOT NULL AND ("image_desktop_url" = '' OR coalesce("image_desktop_width", 0) <= 0 OR coalesce("image_desktop_height", 0) <= 0);
--> statement-breakpoint
UPDATE "banners" SET "image_mobile_url" = NULL, "image_mobile_width" = NULL, "image_mobile_height" = NULL
  WHERE "image_mobile_url" IS NOT NULL AND ("image_mobile_url" = '' OR coalesce("image_mobile_width", 0) <= 0 OR coalesce("image_mobile_height", 0) <= 0);
--> statement-breakpoint
UPDATE "banners" SET "href" = NULL
  WHERE "href" IS NOT NULL AND ("href" !~ '^/[A-Za-z0-9][A-Za-z0-9._~/%?=&#-]*$' OR length("href") > 2000);
--> statement-breakpoint
UPDATE "banners" SET "is_active" = false
  WHERE "is_active" AND ("image_desktop_url" IS NULL OR "image_mobile_url" IS NULL
    OR coalesce("alt_uk", '') !~ '[^[:space:]]' OR coalesce("alt_en", '') !~ '[^[:space:]]');
--> statement-breakpoint
ALTER TABLE "banners" ADD CONSTRAINT "banners_images_valid" CHECK (
    ("banners"."image_desktop_url" IS NULL OR ("banners"."image_desktop_url" <> '' AND "banners"."image_desktop_width" > 0 AND "banners"."image_desktop_height" > 0))
    AND ("banners"."image_mobile_url" IS NULL OR ("banners"."image_mobile_url" <> '' AND "banners"."image_mobile_width" > 0 AND "banners"."image_mobile_height" > 0))
  );--> statement-breakpoint
ALTER TABLE "banners" ADD CONSTRAINT "banners_href_internal" CHECK ("banners"."href" IS NULL OR ("banners"."href" ~ '^/[A-Za-z0-9][A-Za-z0-9._~/%?=&#-]*$' AND length("banners"."href") <= 2000));--> statement-breakpoint
ALTER TABLE "banners" ADD CONSTRAINT "banners_active_complete" CHECK (
    NOT "banners"."is_active" OR (
      "banners"."image_desktop_url" IS NOT NULL AND "banners"."image_mobile_url" IS NOT NULL
      AND coalesce("banners"."alt_uk", '') ~ '[^[:space:]]' AND coalesce("banners"."alt_en", '') ~ '[^[:space:]]'
    )
  );