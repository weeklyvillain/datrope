FROM node:22-alpine AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY clients/core/package.json clients/core/
COPY clients/web/package.json clients/web/
RUN pnpm install --frozen-lockfile
COPY clients/core clients/core
COPY clients/web clients/web
RUN pnpm --filter @datrope/web build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /src/clients/web/dist /srv
