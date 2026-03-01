# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:22-alpine AS production
WORKDIR /app
RUN apk add --no-cache python3 make g++ && \
    addgroup -g 1001 libscope && \
    adduser -u 1001 -G libscope -s /bin/sh -D libscope
COPY package*.json ./
RUN npm ci --omit=dev && apk del python3 make g++
COPY --from=builder /app/dist ./dist
USER libscope
EXPOSE 3420 3421
ENV LIBSCOPE_DATA_DIR=/data
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3420/api/v1/stats').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve"]
