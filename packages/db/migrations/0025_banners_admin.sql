-- Phase 11 (banners): drafts without pictures, alt text, source sizes, internal links only, a period that makes
-- sense, and "only a complete banner can be active". No code wrote this table before, so normally it is empty; a row
-- somebody made by hand is brought inside the new rules instead of failing the migration: a picture without
-- known dimensions is dropped (it could not be shown without a reserved box), a banner left incomplete is switched
-- off, a link that is not a path on this shop and an unknown position are cleared, a reversed period loses its end.
ALTER TABLE "banners" ALTER COLUMN "image_desktop_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "banners" ALTER COLUMN "image_mobile_url" DROP NOT NULL;--> statement-breakpoint
UPDATE "banners" SET "image_desktop_url" = NULL, "image_mobile_url" = NULL;--> statement-breakpoint
UPDATE "banners" SET "href" = NULL WHERE "href" IS NOT NULL AND "href" !~ '^/[A-Za-z0-9]';--> statement-breakpoint
UPDATE "banners" SET "position" = 'home_hero' WHERE "position" <> 'home_hero';--> statement-breakpoint
UPDATE "banners" SET "ends_at" = NULL WHERE "starts_at" IS NOT NULL AND "ends_at" IS NOT NULL AND "starts_at" >= "ends_at";--> statement-breakpoint
UPDATE "banners" SET "is_active" = false;--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN "image_desktop_width" integer;--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN "image_desktop_height" integer;--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN "image_mobile_width" integer;--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN "image_mobile_height" integer;--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN "alt_uk" varchar(300);--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN "alt_en" varchar(300);--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "banners" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "banners" ADD CONSTRAINT "banners_position_known" CHECK ("banners"."position" IN ('home_hero'));--> statement-breakpoint
ALTER TABLE "banners" ADD CONSTRAINT "banners_href_internal" CHECK ("banners"."href" IS NULL OR "banners"."href" ~ '^/[A-Za-z0-9]');--> statement-breakpoint
ALTER TABLE "banners" ADD CONSTRAINT "banners_dates_order" CHECK ("banners"."starts_at" IS NULL OR "banners"."ends_at" IS NULL OR "banners"."starts_at" < "banners"."ends_at");--> statement-breakpoint
ALTER TABLE "banners" ADD CONSTRAINT "banners_images_both_or_none" CHECK (
    ("banners"."image_desktop_url" IS NULL) = ("banners"."image_desktop_width" IS NULL)
    AND ("banners"."image_desktop_url" IS NULL) = ("banners"."image_desktop_height" IS NULL)
    AND ("banners"."image_mobile_url" IS NULL) = ("banners"."image_mobile_width" IS NULL)
    AND ("banners"."image_mobile_url" IS NULL) = ("banners"."image_mobile_height" IS NULL)
  );--> statement-breakpoint
ALTER TABLE "banners" ADD CONSTRAINT "banners_active_complete" CHECK (
    NOT "banners"."is_active" OR (
      "banners"."image_desktop_url" IS NOT NULL AND "banners"."image_mobile_url" IS NOT NULL
      AND coalesce("banners"."alt_uk", '') <> '' AND coalesce("banners"."alt_en", '') <> ''
    )
  );
--> statement-breakpoint
CREATE TRIGGER banners_touch_updated_at BEFORE UPDATE ON banners
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
