-- carts.version is bumped by the database on ANY change to cart_items, so a
-- checkout intent bound to (cart_id, cart_version) goes stale the moment the
-- cart changes in another tab (ADR-11). The application cannot be trusted to
-- remember it: a worker, manual SQL or a forgotten UPDATE would skip it.
--
-- LOCKING (ADR-22): this trigger takes a row lock on carts. Any code that
-- mutates cart_items must lock the parent `carts` row first via acquireLocks,
-- otherwise it deadlocks against checkout.
CREATE OR REPLACE FUNCTION bump_cart_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE carts SET version = version + 1 WHERE id = OLD.cart_id;
    RETURN OLD;
  END IF;
  UPDATE carts SET version = version + 1 WHERE id = NEW.cart_id;
  -- Moving an item between carts changes both.
  IF TG_OP = 'UPDATE' AND OLD.cart_id <> NEW.cart_id THEN
    UPDATE carts SET version = version + 1 WHERE id = OLD.cart_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER cart_items_bump_version
  AFTER INSERT OR UPDATE OR DELETE ON cart_items
  FOR EACH ROW EXECUTE FUNCTION bump_cart_version();
