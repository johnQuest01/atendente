# Backend Mayra AI Sales — imagem de produção para Fly.io
FROM node:20-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependências dos workspaces (só o server é buildado/rodado)
COPY package.json package-lock.json .node-version ./
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm ci --include=dev --workspace=server --include-workspace-root

COPY server ./server

RUN npm run build:server \
  && mkdir -p /data/uploads

ENV NODE_ENV=production
ENV PORT=8080
ENV UPLOAD_DIR=/data/uploads

EXPOSE 8080

# Migrations/seed rodam via release_command no fly.toml
CMD ["npm", "run", "start", "--workspace", "server"]
