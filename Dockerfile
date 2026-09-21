# PinPoint runs on Node's built-in node:sqlite module, so no native build
# toolchain is needed — a slim Debian base keeps things simple and portable.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The SQLite file lives under ./data (resolved relative to server/db.js).
# Mount a persistent volume at /app/data so it survives restarts/redeploys.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
ENV PORT=3000
CMD ["node", "server/index.js"]
