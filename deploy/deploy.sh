#!/usr/bin/env bash
# Сборка и запуск системы на общем сервере okhost.
#
# Запускать из каталога проекта:
#   ./deploy/deploy.sh          собрать и поднять то, что лежит в каталоге
#   ./deploy/deploy.sh --pull   сначала подтянуть свежий master, потом собрать
#
# --pull делает `reset --hard`, а не `merge`: каталог на сервере — не рабочее место,
# правки в нём никто не хранит, а слияние с локальными изменениями подвесило бы выкат
# на конфликте посреди ночи.
#
# Данные переживают пересборку: база лежит в общем infra-postgres, обложки — в томе media.
set -Eeuo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
COMPOSE=(docker compose -f docker-compose.okhost.yml)
CONTAINER=my-posting-app

log() { printf '\n=== %s\n' "$*"; }

if [ "${1:-}" = "--pull" ]; then
  log "Подтягиваю свежий master"
  git fetch --prune origin master
  git reset --hard origin/master
fi

for file in .env .env.infra; do
  if [ ! -f "$file" ]; then
    echo "Нет $PROJECT_DIR/$file — проект не заведён на сервере (okhost new) или не залиты секреты" >&2
    exit 1
  fi
done

# Версия сборки видна в подвале панели и в ответе /health. По ней на глаз проверяется,
# что автодеплой действительно доехал, а не отвалился молча.
APP_REVISION="$(git rev-parse --short HEAD 2>/dev/null || date +%Y-%m-%d)"
export APP_REVISION
log "Запускаю версию $APP_REVISION"

"${COMPOSE[@]}" up -d --build

# Порт наружу не публикуется (наружу пускает только Caddy), поэтому здоровье читаем
# у самого контейнера — healthcheck в compose ходит на /health изнутри.
log "Жду, пока приложение станет здоровым"
for _ in $(seq 1 60); do
  state="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo none)"
  case "$state" in
    healthy)
      echo "Готово: приложение отвечает, версия $APP_REVISION"
      docker image prune -f >/dev/null
      "${COMPOSE[@]}" ps
      exit 0
      ;;
    unhealthy)
      echo "Контейнер поднялся, но проверка здоровья не проходит:" >&2
      "${COMPOSE[@]}" logs --tail 40 app >&2
      exit 1
      ;;
  esac
  sleep 3
done

echo "Приложение не поднялось за 3 минуты, последние строки логов:" >&2
"${COMPOSE[@]}" logs --tail 40 app >&2
exit 1
