#!/usr/bin/env bash
# Сборка и запуск системы на сервере.
#
# Запускать из каталога проекта:
#   ./deploy/deploy.sh
#
# Скрипт пересобирает образ приложения, поднимает контейнеры и ждёт, пока
# приложение ответит на проверку здоровья. Данные (база и картинки) лежат
# в томах docker и пересборку переживают.
set -Eeuo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)

log() { printf '\n=== %s\n' "$*"; }

if [ ! -f .env ]; then
  echo "Нет $PROJECT_DIR/.env, заполните его по образцу .env.example" >&2
  exit 1
fi

# Версия сборки видна в подвале панели и в ответе /health. По ней удобно
# проверять, что на сервере действительно свежая версия.
if [ -f VERSION ]; then
  APP_REVISION="$(tr -d '\r\n' < VERSION)"
else
  APP_REVISION="$(date +%Y-%m-%d)"
fi
export APP_REVISION
log "Запускаю версию $APP_REVISION"

"${COMPOSE[@]}" up -d --build

log "Жду, пока приложение станет здоровым"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 3 http://127.0.0.1:"${APP_PORT:-3000}"/health >/dev/null 2>&1; then
    echo "Готово: приложение отвечает, версия $APP_REVISION"
    # Старые образы после пересборки занимают место, чистим.
    docker image prune -f >/dev/null
    "${COMPOSE[@]}" ps
    exit 0
  fi
  sleep 3
done

echo "Приложение не поднялось за 3 минуты, последние строки логов:" >&2
"${COMPOSE[@]}" logs --tail 40 app >&2
exit 1
