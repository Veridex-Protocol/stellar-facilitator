# Veridex Bazaar Discovery Service - Dockerfile
# License: Apache-2.0

FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

# Install dependencies
RUN npm ci

# Build TypeScript
RUN npm run typecheck && npm run build

# Production image
FROM node:22-alpine

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/migrations ./dist/db/migrations

# Expose ports
EXPOSE 3001
EXPOSE 4001
EXPOSE 4002

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Apply idempotent migrations before serving traffic.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
