# Deployment Guide

## Prerequisites

- Docker 24+
- Kubernetes 1.28+
- Helm 3.x

## Quick Deploy

```bash
helm install myapp ./charts/myapp --namespace production
```

## Configuration

Set environment variables in your `.env` file:

```
DATABASE_URL=postgres://user:pass@host:5432/mydb
REDIS_URL=redis://localhost:6379
LOG_LEVEL=info
```

## Monitoring

Use Prometheus metrics endpoint at `/metrics` for monitoring.
