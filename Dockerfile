# Stage 1: compile TypeScript with the full dev toolchain.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: runtime only. Production deps, compiled JS, non-root user.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Cursor file lives here; a volume is mounted over it in Kubernetes.
RUN mkdir -p /data && chown node:node /data
# Numeric UID on purpose: Kubernetes' runAsNonRoot check cannot verify a named user.
# 1000 is the `node` user in the official image.
USER 1000:1000
EXPOSE 8080
# Run node directly (not via npm) so SIGTERM reaches the process and graceful shutdown runs.
CMD ["node", "dist/main.js"]
