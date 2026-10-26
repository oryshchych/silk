-- updated_at оновлює БД, а не застосунок: інакше воркер, ручний SQL і
-- будь-який забутий .set({ updatedAt }) лишають застарілу мітку.
-- Перелік таблиць — за schema.ts (блок «ДОДАТКОВИЙ SQL», п. 4).
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER products_touch_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
CREATE TRIGGER product_variants_touch_updated_at BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
CREATE TRIGGER orders_touch_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
CREATE TRIGGER categories_touch_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
CREATE TRIGGER customers_touch_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();--> statement-breakpoint
CREATE TRIGGER carts_touch_updated_at BEFORE UPDATE ON carts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
