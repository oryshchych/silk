#!/bin/sh
# Розклад без cron: спати до наступного BACKUP_AT (за TZ, за замовчуванням
# 03:00 Europe/Kyiv), зробити бекап, повторити. Невдача видна в логах
# контейнера й не зупиняє розклад.
set -u
at="${BACKUP_AT:-03:00}"
echo "backup-loop: щодня о ${at} (${TZ:-UTC}), префікс ${BACKUP_PREFIX:-?}"
while true; do
  now=$(date +%s)
  next=$(date -d "today ${at}" +%s)
  [ "$next" -le "$now" ] && next=$(date -d "tomorrow ${at}" +%s)
  sleep $((next - now))
  backup-now || echo "backup-loop: бекап НЕ вдався — див. помилку вище" >&2
done
