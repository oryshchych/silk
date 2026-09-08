#!/usr/bin/env sh
# Обгортка над gitleaks: бінарник, якщо він є, інакше офіційний образ.
#
# Причина обгортки: gitleaks — не npm-пакет, тому на чистій машині його
# може не бути. Хук, який тихо пропускає перевірку за відсутності
# бінарника, гірший за відсутній хук: він створює враження захисту.
# Тому тут або перевірка виконується, або команда падає з інструкцією.
set -eu

if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks "$@"
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  exec docker run --rm \
    -v "$(pwd):/repo:ro" \
    -w /repo \
    zricethezav/gitleaks:latest "$@"
fi

echo "gitleaks не знайдений, і Docker недоступний." >&2
echo "Встановіть: brew install gitleaks   (або запустіть Docker)" >&2
exit 1
