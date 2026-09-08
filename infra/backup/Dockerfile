# Контейнер розкладу бекапів. Сам archive-push виконує Postgres у своєму
# контейнері (тому pgBackRest є і в образі БД) — тут живуть лише
# періодичні full/diff і перевірка репозиторію.
#
# УВАГА: цей шлях перевіряється на кроці деплою фази 0 (потрібні реальні
# креденшели R2). У сесії інфраструктури він не запускався.
FROM alpine:3.22

RUN set -eux; \
    apk add --no-cache pgbackrest postgresql18-client tzdata; \
    install -d -o postgres -g postgres /var/spool/pgbackrest /var/log/pgbackrest

ENV TZ=Europe/Kyiv

COPY crontab /etc/crontabs/postgres
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["crond", "-f", "-l", "8"]
