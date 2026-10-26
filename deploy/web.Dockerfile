FROM node:22-alpine AS web
WORKDIR /src
COPY --from=oven/bun:1.4.4-alpine /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY clients/core/package.json clients/core/
COPY clients/web/package.json clients/web/
COPY clients/desktop/package.json clients/desktop/
RUN bun install --frozen-lockfile
COPY clients/core clients/core
COPY clients/web clients/web
# The commit, shown to clients so they notice when the server runs a newer build.
ARG DATROPE_BUILD=dev
ENV VITE_DATROPE_BUILD=$DATROPE_BUILD
RUN bun run --filter @datrope/web build

# Copies the build into the web volume Caddy serves from (deploy/web-publish.sh), then exits.
FROM alpine:3.20
ARG DATROPE_BUILD=dev
ENV DATROPE_BUILD=$DATROPE_BUILD
COPY --from=web /src/clients/web/dist /dist
COPY deploy/web-publish.sh /web-publish.sh
CMD ["sh", "/web-publish.sh"]
