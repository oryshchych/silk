DROP INDEX "legal_docs_current_idx";--> statement-breakpoint
-- Replaces the 0021 guard (0021 stays as committed). Differences: EVERY column of a published row is compared
-- (`to_jsonb`, so id, created_at, uploaded_by_user_id and any column added later are protected; only
-- `updated_at`, which the touch trigger moves, is excluded); each refusal carries a stable CONSTRAINT name next
-- to SQLSTATE 23514, so callers and tests assert an identity, not a message; and a draft cannot be published with
-- a start more than a minute in the past by direct SQL either (the service already raises it to now()).
CREATE OR REPLACE FUNCTION legal_documents_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'a published legal document is never deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'legal_documents_guard_delete';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'published' THEN
    IF NEW.status <> 'published' THEN
      RAISE EXCEPTION 'a published legal document cannot go back to draft'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'legal_documents_guard_status';
    END IF;
    IF (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'a published legal document is immutable: publish a new version'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'legal_documents_guard_immutable';
    END IF;
  ELSIF NEW.status = 'published' AND NEW.effective_from < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'a version cannot be published with a start in the past'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'legal_documents_guard_past_start';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- Defence in depth: the app role has no TRUNCATE privilege; this also stops an owner-role mistake (a superuser or
-- `session_replication_role = replica` can still bypass a trigger, which is the limit of any trigger).
CREATE FUNCTION legal_documents_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'legal documents are history and are never truncated'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'legal_documents_guard_truncate';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER legal_documents_no_truncate BEFORE TRUNCATE ON legal_documents
  FOR EACH STATEMENT EXECUTE FUNCTION legal_documents_no_truncate();
