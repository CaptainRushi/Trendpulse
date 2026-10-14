# TrendPulse — single-port production image (API + built dashboard on :4317).
# better-sqlite3 ships prebuilds for debian x64, so no toolchain is needed.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
VOLUME ["/app/data", "/app/secrets"]
EXPOSE 4317
# HOST comes from compose (0.0.0.0); without DASHBOARD_PASSWORD the server
# refuses to boot on a non-loopback bind — set it in .env first.
CMD ["node", "server/dist/src/index.js"]
