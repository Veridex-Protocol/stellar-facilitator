# Veridex MCP Discovery Server - Dockerfile
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

# Run MCP server
CMD ["node", "dist/index.js"]
