-- Повнотекстовий пошук: український hunspell + тригер (НЕ generated column).
--
-- Словник uk_ua.{dict,affix} і ukrainian.stop лежать у $SHAREDIR/tsearch_data
-- нашого образу (infra/postgres/Dockerfile). На офіційному образі ця
-- міграція падає — це очікувано.
--
-- Чому тригер: generated column вимагає IMMUTABLE-виразу, а unaccent() і
-- конфігурація з кастомним словником — STABLE.
CREATE TEXT SEARCH DICTIONARY ukrainian_hunspell (
  TEMPLATE  = ispell,
  DictFile  = uk_ua,
  AffFile   = uk_ua,
  StopWords = ukrainian
);--> statement-breakpoint

CREATE TEXT SEARCH CONFIGURATION ukrainian (COPY = simple);--> statement-breakpoint

-- simple як fallback для слів, яких немає в словнику.
ALTER TEXT SEARCH CONFIGURATION ukrainian
  ALTER MAPPING FOR word, hword, hword_part
  WITH ukrainian_hunspell, simple;--> statement-breakpoint

CREATE OR REPLACE FUNCTION products_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('ukrainian', unaccent(coalesce(NEW.name_uk, ''))), 'A') ||
    setweight(to_tsvector('english',   unaccent(coalesce(NEW.name_en, ''))), 'A') ||
    setweight(to_tsvector('simple',    unaccent(coalesce(NEW.brand,   ''))), 'B') ||
    setweight(to_tsvector('simple',    coalesce(NEW.sku,     '')),           'B') ||
    setweight(to_tsvector('ukrainian', unaccent(coalesce(NEW.short_description_uk, ''))), 'C') ||
    setweight(to_tsvector('english',   unaccent(coalesce(NEW.short_description_en, ''))), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER products_search_vector_trg
  BEFORE INSERT OR UPDATE OF name_uk, name_en, brand, sku,
                             short_description_uk, short_description_en
  ON products FOR EACH ROW EXECUTE FUNCTION products_search_vector_update();--> statement-breakpoint

-- Backfill після створення тригера.
-- НЕ `SET updated_at = updated_at`: column-specific тригер спрацьовує за
-- колонками в SET, а не за фактом оновлення рядка. Міграція пройшла б, а
-- наявні товари лишилися б із порожнім вектором.
UPDATE products SET name_uk = name_uk;--> statement-breakpoint

-- Нормалізована колонка для trigram-fallback. Індекс стоїть на ТОМУ САМОМУ
-- виразі, який шукається; індекс на сирому name_uk запит не використав би.
-- GENERATED тут допустимий: lower() і || — IMMUTABLE, unaccent не використано.
--
-- STORED ЯВНО й обов'язково: у PostgreSQL 18 generated columns за
-- замовчуванням VIRTUAL, а віртуальна колонка не індексується — GIN-індекс
-- нижче не побудувався б.
ALTER TABLE products
  ADD COLUMN search_norm text
  GENERATED ALWAYS AS (
    lower(coalesce(name_uk, '') || ' ' || coalesce(name_en, '') || ' ' ||
          coalesce(brand, '')   || ' ' || coalesce(sku, ''))
  ) STORED;--> statement-breakpoint

CREATE INDEX products_search_norm_trgm_idx
  ON products USING gin (search_norm gin_trgm_ops);
