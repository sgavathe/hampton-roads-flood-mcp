# syntax=docker/dockerfile:1

# ---- Build the Angular + ArcGIS front end ----
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npx ng build --configuration production

# ---- API production dependencies ----
FROM node:22-alpine AS api-deps
WORKDIR /src/api
COPY api/package*.json ./
RUN npm ci --omit=dev

# ---- Runtime: one container serves the 3D app, REST API and MCP endpoint ----
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/public \
    DATA_DIR=/app/data
WORKDIR /app
COPY --from=api-deps /src/api/node_modules ./node_modules
COPY api/package.json ./
COPY api/src ./src
COPY data ./data
COPY --from=web /src/web/dist/web/browser ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "src/server.js"]
