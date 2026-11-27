-- Phase 11 (blog), review round. 0028 checked tags by joining them with a comma and matching ONE regex, so the shape
-- depended on the separator: a single tag `a,b` passed, a NULL element passed, a two-dimensional array passed, and a tag
-- longer than 40 characters passed. 0028 is committed and never edited, so the rule is replaced here, PER ELEMENT, in one
-- function that the guard below and the constraint both call (they cannot disagree). Two more rules join it: the address
-- `tag` is reserved (a post with it would shadow `/blog/tag`), and a published post has a body in some language.
--
-- Nothing is guessed: a row that breaks any new rule STOPS the migration with the ids (fix those rows by hand, then run
-- `pnpm db:migrate` again; the failed run rolled back completely, nothing is half applied). The tables are tiny; the
-- constraints are still added NOT VALID and then validated, so the scan runs without the long ACCESS EXCLUSIVE lock.
-- Snapshot `blog_posts` before applying.
CREATE FUNCTION blog_tags_ok(tags text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT tags IS NOT NULL
       AND cardinality(tags) <= 10
       AND (cardinality(tags) = 0 OR array_ndims(tags) = 1)
       AND NOT EXISTS (
         SELECT 1 FROM unnest(tags) AS t
          WHERE t IS NULL OR t !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(t) > 40)
  $$;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "blog_posts" WHERE NOT blog_tags_ok("tags") OR "slug" = 'tag'
      OR ("published_at" IS NOT NULL AND btrim(coalesce("content_uk", '')) = '' AND btrim(coalesce("content_en", '')) = '')) THEN
    RAISE EXCEPTION '0029: a blog post breaks the per-tag, reserved-address or published-needs-text rules; fix it by hand before migrating'
      USING DETAIL = (SELECT string_agg("id"::text, ',' ORDER BY "id") FROM "blog_posts" WHERE NOT blog_tags_ok("tags") OR "slug" = 'tag'
        OR ("published_at" IS NOT NULL AND btrim(coalesce("content_uk", '')) = '' AND btrim(coalesce("content_en", '')) = ''));
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "blog_posts" DROP CONSTRAINT "blog_tags_valid";--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_tags_valid" CHECK (blog_tags_ok("blog_posts"."tags")) NOT VALID;--> statement-breakpoint
ALTER TABLE "blog_posts" VALIDATE CONSTRAINT "blog_tags_valid";--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_slug_reserved" CHECK ("blog_posts"."slug" <> 'tag') NOT VALID;--> statement-breakpoint
ALTER TABLE "blog_posts" VALIDATE CONSTRAINT "blog_slug_reserved";--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_published_has_body" CHECK (
    "blog_posts"."published_at" IS NULL OR btrim(coalesce("blog_posts"."content_uk", '')) <> '' OR btrim(coalesce("blog_posts"."content_en", '')) <> ''
  ) NOT VALID;--> statement-breakpoint
ALTER TABLE "blog_posts" VALIDATE CONSTRAINT "blog_published_has_body";
