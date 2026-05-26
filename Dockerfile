# Use Node.js LTS Alpine image for minimal size
FROM node:22-alpine AS base

# Install runtime tools (ffmpeg for audio) plus the build tooling
# needed by the optional `nodejs-whisper` package, which compiles whisper.cpp
# during `npm ci`. Without these the optional install silently fails and the
# `whisper-local` transcription provider becomes unavailable inside the image.
# Drop `build-base cmake git python3` if you only intend to use the
# OpenAI/Google providers and want a slimmer image.
RUN apk add --no-cache \
    ffmpeg \
    build-base \
    cmake \
    git \
    python3 \
    && rm -rf /var/cache/apk/*

# Set working directory
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --only=production

# Build the application
FROM base AS builder
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build the Next.js application
ENV NODE_ENV production
RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production
ENV PORT 3000

# Copy necessary files
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Transitive runtime deps of the prisma CLI that npm hoisted to the top level
# of node_modules (so they aren't picked up by the @prisma scope COPY above).
# Required by @prisma/config -> jiti for `prisma migrate deploy` at boot.
COPY --from=builder /app/node_modules/jiti ./node_modules/jiti
COPY --from=builder /app/prisma ./prisma

# Create directories for uploads + whisper models (mounted as volumes in production)
RUN mkdir -p uploads whisper-models

# NOTE: Container runs as root. Local docker isolation is fine for dev,
# and managed hosts (Azure App Service, etc.) provide their own user/UID
# remapping plus volume permission handling. Adding a USER directive here
# breaks /home and /var/* persistent mounts on App Service.

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Apply pending Prisma migrations on every boot (idempotent), then start the server.
# Invoke prisma directly via node — `npx prisma` requires the .bin/prisma
# symlink, which isn't present in the runner stage because Next.js standalone
# only traces runtime deps (not the prisma CLI). Without this, the container
# exits with code 127 on Azure App Service.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node server.js"]