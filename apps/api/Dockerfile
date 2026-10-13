# syntax=docker/dockerfile:1
#
# API image.
#
# The API is NOT deployable to Cloudflare Workers. It depends on argon2 and
# sharp, which are native Node addons, and on Prisma's query engine, which ships
# as a platform binary. Workers has no native module support and no writable
# filesystem, so none of those can load there. This image targets a real Node
# runtime (Render, Fly, Railway, a VM).
#
# Build from the REPOSITORY ROOT, not from apps/api, because it is an npm
# workspace monorepo and the API imports a sibling package:
#
#   docker build -f apps/api/Dockerfile -t njp-api .
#
# ---------------------------------------------------------------------------
# Why the full Debian image rather than -slim
# ---------------------------------------------------------------------------
# `node:22-bookworm-slim` does NOT ship libssl3 or ca-certificates. Both are
# hard runtime requirements here:
#
#   - Prisma's Debian query engine dynamically links libssl3 and fails on the
#     first query without it.
#   - ca-certificates is what makes outbound HTTPS work at all, and this API
#     talks to R2, Cloudflare Stream, Google and Termii.
#
# The usual fix is `apt-get install`, which is what a slim Dockerfile would do.
# That step depends on deb.debian.org being reachable from the build, which is
# not something this project controls and which failed on a machine with a
# restricted or proxied Docker network. Since `node:22-bookworm` already contains
# openssl, ca-certificates AND the C/C++ toolchain that argon2 and sharp fall
# back on, using it removes every apt call and makes the build reproducible on a
# locked-down network.
#
# The cost is image size. If that becomes a problem the correct change is to
# build on the full image and copy the two shared libraries into a slim runtime,
# which keeps the apt step out of the build without losing the size saving.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Stage 1: dependencies
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS deps
WORKDIR /repo

ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# Copy manifests only. `npm ci` resolves the whole workspace tree from these, and
# nothing else, so this layer stays cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json            apps/api/
COPY apps/web/package.json            apps/web/
COPY packages/contracts/package.json  packages/contracts/
COPY packages/ui/package.json         packages/ui/
COPY packages/client/package.json     packages/client/
COPY packages/config/package.json     packages/config/

# --include-workspace-root pulls in the root devDependencies (turbo, typescript),
# which the build needs because it is driven from the root.
RUN npm ci --include-workspace-root

# ---------------------------------------------------------------------------
# Stage 2: build
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY . .

# Prisma client before compiling: the API's TypeScript depends on the generated
# client types, so generating afterwards fails on a cold cache.
RUN npm run prisma:generate --workspace @naijaproperty/api

# contracts and ui are compiled before the API because the API imports their
# built output through their package.json main/types.
RUN npm run build --workspace @naijaproperty/contracts \
 && npm run build --workspace @naijaproperty/ui \
 && npm run build --workspace @naijaproperty/api

# Strip dev dependencies from the tree carried into the runtime stage, so
# typescript, turbo and the Nest CLI do not ship.
RUN npm prune --omit=dev --include-workspace-root

# ---------------------------------------------------------------------------
# Stage 3: runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS runtime
WORKDIR /repo

ENV NODE_ENV=production

# Bind every interface. The default 127.0.0.1 inside a container is unreachable
# from the host, which is the classic "works locally, 502s in production"
# deployment failure.
#
# PORT is deliberately NOT set here. Railway, Render and Fly all inject PORT at
# runtime and route their proxy to it; baking a value into the image would
# shadow that. The application falls back to API_PORT (4000) when PORT is
# absent, which is the local case.
ENV HOST=0.0.0.0
ENV API_PORT=4000

# --chown on COPY rather than a separate `chown -R` layer.
#
# Ownership is set as the files land, so there is no extra full-tree pass over
# node_modules. The separate RUN version took over six minutes on its own here,
# which was most of the build time and would be paid again on every deploy.
COPY --from=build --chown=node:node /repo/node_modules       ./node_modules
COPY --from=build --chown=node:node /repo/package.json       ./package.json
COPY --from=build --chown=node:node /repo/apps/api           ./apps/api
COPY --from=build --chown=node:node /repo/packages/contracts ./packages/contracts
COPY --from=build --chown=node:node /repo/packages/ui        ./packages/ui
COPY --from=build --chown=node:node /repo/packages/client    ./packages/client

USER node

EXPOSE 4000

# Liveness only. This deliberately does not touch Postgres: the app is expected
# to boot and stay up while the database is briefly unavailable, so probing a
# dependency here would convert a database blip into a container restart loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# NOTE ON MIGRATIONS
# `npm run db:deploy` (prisma migrate deploy) is deliberately NOT run at
# container start. Two replicas booting together would race, and two processes
# applying the same migration is a production outage. Run it once from a
# pre-deploy/release step before traffic shifts. On Render that is the
# "Pre-deploy Command" field.
CMD ["npm", "run", "start", "--workspace", "@naijaproperty/api"]
