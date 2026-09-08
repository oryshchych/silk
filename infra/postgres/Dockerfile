# Власний образ Postgres. Офіційний не підходить із двох причин:
#
#  1. Українська конфігурація повнотекстового пошуку вимагає hunspell-словника
#     у $SHAREDIR/tsearch_data. Без нього `CREATE TEXT SEARCH DICTIONARY ...
#     (TEMPLATE = ispell)` падає, тобто міграція не проходить.
#  2. pgBackRest мусить бути в тому ж контейнері, що й Postgres: archive_command
#     виконується сервером БД (REVIEW_TRIAGE — «pgBackRest у образі Postgres,
#     а не тільки backup»).
#
# База — Debian (postgres:18), НЕ alpine, попри коментар у первісному
# docker-compose.yml: в Alpine немає пакета hunspell-uk (перевірено
# `apk search hunspell` — лише англійські). Тягнути словник із мережі на
# кожен білд гірше, ніж узяти його з дистрибутива.
FROM postgres:18

# Мажор фіксований (18), не «останній»: апгрейд мажора — окрема операція
# з планом, а не наслідок перезбірки образу.

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      hunspell-uk \
      hunspell-en-us \
      pgbackrest \
      locales; \
    rm -rf /var/lib/apt/lists/*

# Словники Postgres шукає в $SHAREDIR/tsearch_data і вимагає розширень
# .dict / .affix у нижньому регістрі. Копія, а не symlink: файли мусять
# лишитися на місці, навіть якщо пакет прибрали.
RUN set -eux; \
    SHAREDIR="$(pg_config --sharedir)"; \
    install -d "$SHAREDIR/tsearch_data"; \
    iconv -f UTF-8 -t UTF-8 /usr/share/hunspell/uk_UA.dic > "$SHAREDIR/tsearch_data/uk_ua.dict"; \
    iconv -f UTF-8 -t UTF-8 /usr/share/hunspell/uk_UA.aff > "$SHAREDIR/tsearch_data/uk_ua.affix"; \
    cp /usr/share/hunspell/en_US.dic "$SHAREDIR/tsearch_data/en_us.dict"; \
    cp /usr/share/hunspell/en_US.aff "$SHAREDIR/tsearch_data/en_us.affix"

# Список стоп-слів. Потрібен явно: конфігурація пошуку на нього
# посилається, і без файла міграція падає (REVIEW_TRIAGE, раунд 3).
COPY tsearch/ukrainian.stop /tmp/ukrainian.stop
RUN set -eux; \
    SHAREDIR="$(pg_config --sharedir)"; \
    cp /tmp/ukrainian.stop "$SHAREDIR/tsearch_data/ukrainian.stop"; \
    rm /tmp/ukrainian.stop

# init-скрипти вбудовані в образ, а НЕ монтуються з хоста: інакше стек
# залежить від налаштувань file sharing у Docker Desktop, і на чистій
# машині `pnpm dev` падає на mount, а не на чомусь зрозумілому.
# Виконуються офіційним entrypoint лише при ініціалізації порожнього volume.
COPY init/ /docker-entrypoint-initdb.d/

# Перевірка на етапі збірки: якщо файлів немає, образ не мусить існувати.
RUN set -eux; \
    SHAREDIR="$(pg_config --sharedir)"; \
    test -s "$SHAREDIR/tsearch_data/uk_ua.dict"; \
    test -s "$SHAREDIR/tsearch_data/uk_ua.affix"; \
    test -s "$SHAREDIR/tsearch_data/ukrainian.stop"; \
    test -x /docker-entrypoint-initdb.d/01-roles.sh; \
    pgbackrest version
