#
# Scholium web image (Next.js App Router, standalone output).
#
# Build from the repository root (npm workspaces keep apps/web in the root
# lockfile):
#
#   podman build -f deploy/containers/web.Containerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.org -t scholium-web .
#   docker build -f deploy/containers/web.Containerfile \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.org -t scholium-web .
#
# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so the
# API URL is a build argument rather than a runtime setting. The same value
# feeds the Content-Security-Policy in next.config.js, so a built image cannot
# load from one origin and fetch from another.

FROM node:22-alpine AS builder

LABEL org.opencontainers.image.title="scholium-web" \
      org.opencontainers.image.description="Scholium web app (Next.js standalone server)" \
      org.opencontainers.image.source="https://github.com/scholium/scholium"

# NODE_ENV is deliberately absent here: npm ci omits devDependencies when it
# is production, and `next build` needs TypeScript and its types. The build
# command sets NODE_ENV=production itself.
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Dependency layer: the root workspace manifest, lockfile and the app's own
# manifest are enough for `npm ci` to install the workspace from the lockfile.
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
RUN npm ci --no-audit --no-fund

# Application sources and the config files `next build` reads. Copied
# explicitly, not as the whole directory: docker build only reads
# .dockerignore, so copying apps/web wholesale could drag host node_modules
# (built for another platform) over the clean install above.
COPY apps/web/src ./apps/web/src
COPY apps/web/public ./apps/web/public
COPY apps/web/next.config.js \
     apps/web/next-env.d.ts \
     apps/web/postcss.config.mjs \
     apps/web/tailwind.config.ts \
     apps/web/tsconfig.json \
     ./apps/web/

# The handbook the docs pages are generated from. The build reads it from
# ../../docs/handbook relative to apps/web (see src/features/docs), so it must
# be here before `npm run build` or /docs has no chapters to statically
# generate. Only the handbook travels: the docs' screenshots and posters live
# in apps/web/public, which is already copied above.
COPY docs/handbook ./docs/handbook

# Public API origin used by the browser bundle and the CSP's connect-src. An
# unset value falls back to http://localhost:8000 exactly as a local dev run.
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
# Public origin of this deployment (share links, OG images). Optional at build
# time; a production deployment must set it to a non-loopback URL.
ARG NEXT_PUBLIC_SITE_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

RUN npm run build --workspace apps/web

# Runtime: only the traced standalone server, static assets and public files.
FROM node:22-alpine AS runner

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

WORKDIR /app

# The standalone bundle reproduces the workspace layout the build traced from:
# apps/web/server.js plus the hoisted node_modules beside it.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

# `node` is the image's unprivileged user (uid 1000), not root.
USER node
WORKDIR /app/apps/web

EXPOSE 3000

CMD ["node", "server.js"]
