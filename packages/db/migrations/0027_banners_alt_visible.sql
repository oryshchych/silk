-- Phase 11 (banners), review round: "visible alt text" is now ONE explicit character set instead of the locale-dependent
-- `[[:space:]]` of 0026 (which let a no-break space or zero-width characters count as text). 0026 is committed, so the
-- constraint is replaced here. The same set is in `ALT_VISIBLE_CLASS` (Zod) and `SHOWN_NOW` (the public read), and a test
-- pins that the three agree. An active banner whose alt text has nothing visible in it is switched off BEFORE the new
-- constraint is added, so the migration cannot fail on old data. Snapshot `banners` before applying (forward-only).
ALTER TABLE "banners" DROP CONSTRAINT "banners_active_complete";--> statement-breakpoint
UPDATE "banners" SET "is_active" = false
  WHERE "is_active" AND (coalesce("alt_uk", '') !~ '[^ \t\n\r\f\v\u00A0\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]' OR coalesce("alt_en", '') !~ '[^ \t\n\r\f\v\u00A0\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]');
--> statement-breakpoint
ALTER TABLE "banners" ADD CONSTRAINT "banners_active_complete" CHECK (
    NOT "banners"."is_active" OR (
      "banners"."image_desktop_url" IS NOT NULL AND "banners"."image_mobile_url" IS NOT NULL
      AND coalesce("banners"."alt_uk", '') ~ '[^ \t\n\r\f\v\u00A0\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]' AND coalesce("banners"."alt_en", '') ~ '[^ \t\n\r\f\v\u00A0\u2000-\u200D\u2028\u2029\u202F\u205F\u2060\u3000\uFEFF]'
    )
  );