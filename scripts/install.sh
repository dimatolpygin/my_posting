#!/usr/bin/env bash
# Первичная подготовка сервера Ubuntu под систему автопостинга.
# Скрипт можно запускать повторно, ничего не сломается и не задвоится.
#
#   1. распакуйте код проекта в /opt/projects/my-posting
#   2. cd /opt/projects/my-posting && cp .env.example .env && nano .env   (заполнить настройки)
#   3. ./scripts/install.sh
#
# Что делает: подкачку памяти, docker, часовой пояс Москвы, ночной бэкап базы,
# сборку и запуск системы.
set -Eeuo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

log() { printf '\n=== %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Запускать от root: sudo ./scripts/install.sh" >&2
  exit 1
fi

# --- swap ---------------------------------------------------------------
# На сервере 2 ГБ ОЗУ, а `docker compose build` для node-образа легко берёт больше.
# Без swap сборка падает по OOM в самом неочевидном месте.
log "swap"
if swapon --show | grep -q swapfile; then
  echo "swap уже есть"
else
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap 2G подключён"
fi

# --- пакеты и docker ----------------------------------------------------
log "пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates cron >/dev/null

log "docker"
if command -v docker >/dev/null; then
  docker --version
else
  curl -fsSL https://get.docker.com | sh >/tmp/docker-install.log 2>&1
  docker --version
fi
docker compose version

# --- часовой пояс -------------------------------------------------------
# Расписание постинга и post_at в postmypost живут в МСК. Сервер в UTC даст
# сдвиг на три часа в cron-прогонах и в бэкапах.
log "часовой пояс"
timedatectl set-timezone Europe/Moscow || true
date

# --- .env ---------------------------------------------------------------
log ".env"
if [ ! -f .env ]; then
  echo "Нет $PROJECT_DIR/.env — скопируйте .env.example и заполните секреты" >&2
  exit 1
fi
chmod 600 .env
for KEY in POSTGRES_PASSWORD SESSION_SECRET ADMIN_PASSWORD PUBLIC_BASE_URL DOMAIN; do
  grep -q "^$KEY=..*" .env || { echo "В .env не заполнен $KEY" >&2; exit 1; }
done
grep -q '^PUBLIC_BASE_URL=https://' .env || {
  echo "PUBLIC_BASE_URL на проде обязан быть https-адресом домена: postmypost сам" \
       "скачивает обложку по этому URL" >&2
  exit 1
}

# --- бэкап по расписанию ------------------------------------------------
log "cron бэкапа"
chmod +x deploy/backup-db.sh deploy/deploy.sh
install -d -m 755 /opt/projects/my-posting/backups
cat > /etc/cron.d/my-posting-backup <<CRON
# Ночной дамп базы my-posting. Время московское (сервер переведён в Europe/Moscow).
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 3 * * * root cd $PROJECT_DIR && ./deploy/backup-db.sh >> /var/log/my-posting-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/my-posting-backup
systemctl restart cron
echo "бэкап: каждый день в 03:30 МСК → /opt/projects/my-posting/backups"

# --- ротация логов docker ----------------------------------------------
# Лимит на уровне демона — страховка на случай контейнеров, поднятых мимо compose.
log "ротация логов docker"
if [ ! -f /etc/docker/daemon.json ]; then
  install -d -m 755 /etc/docker
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
  systemctl restart docker
  echo "лимит логов задан"
else
  echo "/etc/docker/daemon.json уже есть, не трогаю"
fi

# --- автозапуск после перезагрузки --------------------------------------
# У всех сервисов restart: unless-stopped, а сам docker включается в systemd —
# этого достаточно, чтобы стек поднялся после ребута.
systemctl enable docker >/dev/null 2>&1 || true

# --- выкат --------------------------------------------------------------
log "выкат стека"
./deploy/deploy.sh

log "готово"
echo "Панель: $(grep '^PUBLIC_BASE_URL=' .env | cut -d= -f2-)"
