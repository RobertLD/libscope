# Debian (glibc) base: the local embedding model (onnxruntime-node) does not run on Alpine (musl).

# Build stage
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:22-bookworm-slim AS production
WORKDIR /app
RUN groupadd -g 1001 libscope && \
    useradd -u 1001 -g libscope -s /bin/sh -M libscope && \
    mkdir /data && chown libscope:libscope /data
COPY package*.json ./
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    npm ci --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3 sharp && \
    npm cache clean --force && \
    apt-get purge -y python3 make g++ && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/dist ./dist
USER libscope
# Config, secrets, connections and workspace databases live in $HOME/.libscope.
ENV HOME=/data
VOLUME ["/data"]
EXPOSE 3378
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3378/api/v1/health').then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve", "api", "--host", "0.0.0.0", "--port", "3378"]
