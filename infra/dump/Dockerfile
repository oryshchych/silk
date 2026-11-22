# Щоденний логічний бекап (pg_dump) у Cloudflare R2 — критерій фази 0.
#
# Те саме мажорне Postgres, що й БД (pg_dump мусить бути не старішим за
# сервер). rclone — з Debian, підтримує провайдера Cloudflare R2.
# Безперервне архівування WAL (pgBackRest, infra/backup) — окремо, перед
# запуском production (NOTES.md).
FROM postgres:18

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends rclone ca-certificates; \
    rm -rf /var/lib/apt/lists/*

COPY dump.sh /usr/local/bin/backup-now
COPY loop.sh /usr/local/bin/backup-loop
RUN chmod +x /usr/local/bin/backup-now /usr/local/bin/backup-loop

# Налаштування rclone — лише зі змінних (dump.sh); конфіг-файла немає.
ENV TZ=Europe/Kyiv RCLONE_CONFIG=/dev/null
USER postgres
CMD ["backup-loop"]
