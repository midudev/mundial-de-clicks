# Dockerfile de producción para el Mundial de Clicks (Astro SSR + Node).
# Multi-stage: build con todas las dependencias, runtime mínimo.

# ---- Build ----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# pnpm vía corepack (respeta la versión del proyecto).
RUN corepack enable

# Instalar dependencias (capa cacheable).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Construir la app.
COPY . .
RUN pnpm build

# ---- Runtime --------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Solo lo necesario para ejecutar el server standalone.
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist

# El adaptador Node lee HOST y PORT del entorno.
ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321

CMD ["node", "./dist/server/entry.mjs"]
