# syntax=docker/dockerfile:1

# Реестр npm. По умолчанию официальный; на машинах, откуда registry.npmjs.org
# не отвечает (у контейнера свой маршрут в интернет, мимо VPN хоста), сборка
# запускается с зеркалом:
#   docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org

FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
# tini — корректная передача SIGTERM в Node (иначе graceful shutdown не срабатывает).
# tzdata обязательна: без неё переменная TZ на alpine игнорируется и контейнер живёт в UTC,
# а проекту нужна МСК (расписание постинга и post_at в postmypost идут с +03:00).
RUN apk add --no-cache tini curl tzdata
ENV TZ=Europe/Moscow

# --- слой зависимостей: пересобирается только при изменении package*.json ---
FROM base AS deps
ARG NPM_REGISTRY
RUN npm config set registry "$NPM_REGISTRY"
COPY package*.json ./
RUN npm ci --omit=dev

# --- dev: те же зависимости + dev-инструменты, код монтируется томом ---
# Автосборка идёт через nodemon в режиме --legacy-watch (polling): нативный inotify
# не пробрасывается через bind-mount Docker Desktop на Windows/macOS, поэтому
# `node --watch` правки хостовых файлов не видит.
FROM base AS dev
ENV NODE_ENV=development
ARG NPM_REGISTRY
RUN npm config set registry "$NPM_REGISTRY"
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "dev"]

# --- prod ---
FROM base AS prod
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY docs/prompts ./docs/prompts
RUN mkdir -p /app/media && chown -R node:node /app
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
