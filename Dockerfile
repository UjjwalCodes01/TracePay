# TracePay as one service: the API, which also serves the built web app (Google Cloud Run).
#   gcloud builds submit --tag <region>-docker.pkg.dev/<project>/tracepay/tracepay
# Secrets are never in the image: they come from Secret Manager at run time.

FROM node:24-slim AS build
# Prisma's migration engine needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/mcp/package.json packages/mcp/
RUN npm ci
COPY . .
RUN npm run build -w @tracepay/api && npm run build -w @tracepay/web

FROM node:24-slim
# The commit this image was built from, reported by /api/health.
ARG COMMIT=unknown
ENV TRACEPAY_COMMIT=$COMMIT
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST_DIR=/app/apps/web/dist
WORKDIR /app
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/api
USER node
EXPOSE 8080
# Apply pending migrations (retried while a sleeping database wakes), then serve.
CMD ["sh", "-c", "node scripts/migrate-deploy.mjs && exec node dist/server.js"]
