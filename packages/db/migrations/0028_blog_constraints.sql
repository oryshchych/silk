-- Phase 11 (blog): the table had no writer before, so normally it is empty. What is normalised: a NULL tag list becomes
-- an empty one (the column becomes NOT NULL with that default). What is NOT guessed: a row whose slug, tags or text break
-- the new rules stops the migration with the ids, to be fixed by hand (a slug is a public address; a silent rewrite
-- would break links). The updated_at trigger already exists (0007). Snapshot `blog_posts` first.
UPDATE "blog_posts" SET "tags" = '{}'::text[] WHERE "tags" IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "blog_posts" WHERE "slug" !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length("slug") > 120
      OR cardinality("tags") > 10
      OR (cardinality("tags") > 0 AND array_to_string("tags", ',') !~ '^[a-z0-9]+(-[a-z0-9]+)*(,[a-z0-9]+(-[a-z0-9]+)*)*$')
      OR char_length(coalesce("content_uk", '')) > 100000 OR char_length(coalesce("content_en", '')) > 100000) THEN
    RAISE EXCEPTION '0028: a blog post breaks the new slug, tag or length rules; fix it by hand before migrating'
      USING DETAIL = (SELECT string_agg("id"::text, ',') FROM "blog_posts" WHERE "slug" !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
        OR length("slug") > 120 OR cardinality("tags") > 10
        OR (cardinality("tags") > 0 AND array_to_string("tags", ',') !~ '^[a-z0-9]+(-[a-z0-9]+)*(,[a-z0-9]+(-[a-z0-9]+)*)*$')
        OR char_length(coalesce("content_uk", '')) > 100000 OR char_length(coalesce("content_en", '')) > 100000);
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "blog_posts" ALTER COLUMN "tags" SET DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "blog_posts" ALTER COLUMN "tags" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "blog_tags_idx" ON "blog_posts" USING gin ("tags");--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_slug_format" CHECK ("blog_posts"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("blog_posts"."slug") <= 120);--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_tags_valid" CHECK (
    cardinality("blog_posts"."tags") <= 10
    AND (cardinality("blog_posts"."tags") = 0
      OR (array_to_string("blog_posts"."tags", ',') ~ '^[a-z0-9]+(-[a-z0-9]+)*(,[a-z0-9]+(-[a-z0-9]+)*)*$'
          AND length(array_to_string("blog_posts"."tags", ',')) <= 410))
  );--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_content_length" CHECK (
    char_length(coalesce("blog_posts"."content_uk", '')) <= 100000 AND char_length(coalesce("blog_posts"."content_en", '')) <= 100000
  );
