# Veridex x402 Gateway
# License: Apache-2.0
FROM node:22-alpine AS build
WORKDIR /repo
COPY sdk-typescript/package.json sdk-typescript/package-lock.json ./sdk-typescript/
RUN npm --prefix sdk-typescript ci
COPY sdk-typescript/tsconfig.json ./sdk-typescript/
COPY sdk-typescript/src ./sdk-typescript/src
RUN npm --prefix sdk-typescript run build

WORKDIR /repo/gateway-service
COPY gateway-service/package.json gateway-service/package-lock.json ./
RUN npm ci
COPY gateway-service/tsconfig.json ./
COPY gateway-service/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /repo
COPY --from=build /repo/sdk-typescript/package.json ./sdk-typescript/
COPY --from=build /repo/sdk-typescript/dist ./sdk-typescript/dist
WORKDIR /repo/gateway-service
COPY gateway-service/package.json gateway-service/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /repo/gateway-service/dist ./dist
COPY gateway-service/gateway.playground.json ./gateway.config.json
RUN mkdir -p /var/lib/veridex/gateway && chown -R node:node /var/lib/veridex/gateway
USER node
EXPOSE 3005
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -q -O /dev/null http://127.0.0.1:3005/health || exit 1
CMD ["node", "dist/index.js"]