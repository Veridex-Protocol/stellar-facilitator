# Veridex x402 Playground
# License: Apache-2.0
#
# Two stages so the runtime image carries no build tooling and no source: the
# bundler and the TypeScript compiler stay behind in the builder.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json tsconfig.web.json ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
# The Stellar SDK and the x402 packages are build-time only: they are bundled
# into public/bundle.js and run in the visitor's browser, never in this process.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

# Nothing here needs to write to disk or hold a credential.
USER node
EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PLAYGROUND_PORT||3004)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
