# syntax=docker/dockerfile:1

# Build context is the workspace root, not apps/api: pnpm needs the root
# manifest, the lockfile, and the workspace definition to resolve
# @scheduler/contracts.
#
# Optimised for reproducibility over image size. The runtime layer keeps the
# full dependency tree because `prisma migrate deploy` runs at startup, and the
# migrations -- not the Prisma schema -- are what create the exclusion
# constraints this system's correctness depends on. Dropping the CLI to save a
# hundred megabytes would mean shipping a container that cannot apply them.

FROM node:22-slim AS base
# Prisma's query engine links against OpenSSL.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# Manifests only, so a source edit does not invalidate the install layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
# Contracts first: apps/api resolves it through the workspace symlink to built
# output, so the order is a real dependency rather than a convention.
RUN pnpm --filter @scheduler/contracts build \
 && pnpm --filter @scheduler/api exec prisma generate \
 && pnpm --filter @scheduler/api exec nest build

FROM build AS runtime
ENV NODE_ENV=production
WORKDIR /repo/apps/api
EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=10 \
  CMD curl -fsS http://localhost:3000/health || exit 1

# migrate deploy, never db push: the GiST exclusion constraints exist only in
# hand-written migration SQL. Pushing the schema would create tables with no
# constraints and a container that silently permits double-booking.
CMD ["sh", "-c", "pnpm prisma migrate deploy && exec node dist/main.js"]
