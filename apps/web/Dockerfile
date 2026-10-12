# syntax=docker/dockerfile:1
#
# Web image (Next.js).
#
# This is the fallback and local-parity target. The intended production home for
# the web app is Cloudflare Workers via @opennextjs/cloudflare; this image exists
# so the app can also run on an ordinary Node host (Render, Fly, Railway) and so
# the local stack can run the real production artefact rather than `next start`.
#
# Build from the REPOSITORY ROOT:
#
#   docker build -f apps/web/Dockerfile -t njp-web .
#
# ---------------------------------------------------------------------------
# On the images config in next.config.ts
# ---------------------------------------------------------------------------
# `images.remotePatterns` and `images.formats` are inert in this app. There is no
# `next/image` usage anywhere in the source: all ten images are plain <img> tags
# pointing straight at R2 or Stream URLs. The config is kept because it is
# harmless, but do not assume an image optimizer is running. R2 and Stream serve
# and resize the media themselves.

# ---------------------------------------------------------------------------
# Stage 1: dependencies
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS deps
WORKDIR /repo

ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

COPY package.json package-lock.json ./
COPY apps/api/package.json            apps/api/
COPY apps/web/package.json            apps/web/
COPY packages/contracts/package.json  packages/contracts/
COPY packages/ui/package.json         packages/ui/
COPY packages/client/package.json     packages/client/
COPY packages/config/package.json     packages/config/

RUN npm ci --include-workspace-root

# ---------------------------------------------------------------------------
# Stage 2: build
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY . .

# contracts and ui must be compiled first: the web app imports their built output
# through their package.json main/types, and `transpilePackages` only handles
# source, not a missing dist.
RUN npm run build --workspace @naijaproperty/contracts \
 && npm run build --workspace @naijaproperty/ui

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so they
# are build arguments rather than runtime environment. Passing them only at
# runtime is the classic way to ship a bundle pointing at localhost.
#
# Defaults are deliberately empty rather than localhost: a build that silently
# defaults to http://localhost:3000 produces a site whose API calls all fail in
# production, which is much harder to diagnose than a missing variable.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WEB_URL
ARG NEXT_PUBLIC_SITE_NAME=Naijaproperty
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WEB_URL=$NEXT_PUBLIC_WEB_URL
ENV NEXT_PUBLIC_SITE_NAME=$NEXT_PUBLIC_SITE_NAME

# NODE_ENV=production also turns off source maps in the client bundle.
ENV NODE_ENV=production
RUN npm run build --workspace @naijaproperty/web

# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS runtime
WORKDIR /app

ENV NODE_ENV=production

# 0.0.0.0, never 127.0.0.1: a container bound to loopback is unreachable from
# the host and renders as a connection reset rather than a clear error.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# `output: 'standalone'` traces only what this app actually reaches, so this
# folder already contains node_modules with the right dependency closure. No
# separate install step and no full node_modules copy.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
# Static assets and public/ are not traced by default; without these two copies
# every page 404s on its CSS and JS.
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
