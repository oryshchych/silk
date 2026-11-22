# Щоденний логічний бекап (pg_dump) у Cloudflare R2 — критерій фази 0.
#
# Те саме мажорне Postgres, що й БД (pg_dump мусить бути не старішим за
# сервер).
#
# rclone — НЕ з пакета Debian: rclone 1.60 після завантаження робить
# додатковий запит, який Cloudflare R2 не підтримує (501 NotImplemented),
# тож кожен бекап закінчувався помилкою, хоча файл у R2 з'являвся.
# Актуальний rclone (статичний Go-бінарник) беремо з офіційного образу,
# закріпленого за digest — тег можна перезаписати, digest ні. Оновлює
# Renovate.
# Безперервне архівування WAL (pgBackRest, infra/backup) — окремо, перед
# запуском production (NOTES.md).
FROM rclone/rclone:1.76.0@sha256:7cbeec24a44f206067597c0368be4de90ae19a64d5113c7d1938bd737a81e466 AS rclone

FROM postgres:18

# ca-certificates — для TLS до R2.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    rm -rf /var/lib/apt/lists/*

COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY dump.sh /usr/local/bin/backup-now
COPY loop.sh /usr/local/bin/backup-loop
RUN chmod +x /usr/local/bin/backup-now /usr/local/bin/backup-loop

# Налаштування rclone — лише зі змінних (dump.sh); конфіг-файла немає.
ENV TZ=Europe/Kyiv RCLONE_CONFIG=/dev/null
USER postgres
CMD ["backup-loop"]
