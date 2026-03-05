#!/usr/bin/env bash
# =============================================================================
# libscope — Enterprise Readiness: GitHub Milestone + Issues Creator
# =============================================================================
# Usage:
#   export GH_TOKEN=<your-github-personal-access-token>
#   bash scripts/create-enterprise-milestone.sh
#
# Requires: curl, jq
# Needs a token with repo scope (read/write issues & milestones)
# =============================================================================

set -euo pipefail

REPO="RobertLD/libscope"
API="https://api.github.com"
TOKEN="${GH_TOKEN:?Set GH_TOKEN to a GitHub PAT with repo scope}"

gh_post() {
  local path="$1"
  local body="$2"
  curl -sfS -X POST \
    -H "Authorization: token $TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$API/repos/$REPO/$path"
}

log() { echo "  ✓ $*"; }
section() { echo -e "\n▶ $*"; }

# =============================================================================
# 1. Create Milestone
# =============================================================================
section "Creating milestone: Enterprise Readiness"

MILESTONE=$(gh_post "milestones" '{
  "title": "Enterprise Readiness",
  "description": "Features and hardening needed to make libscope suitable for enterprise multi-user deployments: SSO, RBAC, audit logging, scalability, compliance, and observability.",
  "state": "open"
}')

MILESTONE_NUMBER=$(echo "$MILESTONE" | jq -r '.number')
log "Milestone #$MILESTONE_NUMBER created"

# Helper — create one issue and attach it to the milestone
create_issue() {
  local title="$1"
  local body="$2"
  local labels="$3"

  local payload
  payload=$(jq -n \
    --arg t "$title" \
    --arg b "$body" \
    --arg m "$MILESTONE_NUMBER" \
    --argjson l "$labels" \
    '{title: $t, body: $b, milestone: ($m | tonumber), labels: $l}')

  local resp
  resp=$(gh_post "issues" "$payload")
  local num
  num=$(echo "$resp" | jq -r '.number')
  log "#$num — $title"
}

# =============================================================================
# 2. Create Issues
# =============================================================================

section "Creating issues…"

# ── Security & Auth ──────────────────────────────────────────────────────────

create_issue \
  "SSO / OAuth2 / SAML integration for enterprise identity providers" \
  "## Problem
Enterprise teams manage identity centrally (Okta, Azure AD, Google Workspace, Ping). Today libscope has no federated login — every user needs a separate local account. IT teams will reject tools that can't plug into their IdP.

## Proposed solution
- Add an optional SSO layer (OAuth 2.0 Authorization Code flow + PKCE; SAML 2.0 SP-initiated)
- Support: **Okta**, **Azure AD / Entra ID**, **Google Workspace**, **Ping Identity**, generic OIDC
- Automatic user provisioning on first login (SCIM 2.0 for lifecycle management)
- CLI \`libscope auth login --provider=okta --domain=company.okta.com\`
- Machine-to-machine auth via client credentials flow for CI/CD pipelines

## Acceptance criteria
- [ ] OIDC discovery document auto-import (well-known endpoint)
- [ ] SAML 2.0 metadata import/export
- [ ] JIT provisioning with configurable default role
- [ ] SCIM 2.0 endpoints for user/group lifecycle
- [ ] Session management (idle timeout, absolute timeout, concurrent session limits)
- [ ] Integration tests for Okta sandbox and Azure AD v2 endpoints" \
  '["enhancement","security","enterprise","auth"]'

create_issue \
  "Role-Based Access Control (RBAC) with fine-grained permissions" \
  "## Problem
libscope has zero multi-user access control — anyone who can reach the server can read, write, or delete every document. Enterprise procurement requires least-privilege data access.

## Proposed solution
Introduce a permission model:

| Role | Capabilities |
|---|---|
| **Viewer** | Read documents, search, ask RAG questions |
| **Contributor** | + Add / edit / delete own documents |
| **Librarian** | + Manage any document, topics, tags, connectors |
| **Admin** | + Manage users, roles, audit logs, system config |

- Workspace-scoped permissions (user X is Librarian in workspace A but Viewer in B)
- API key permissions inherit the creating user's role
- Row-level security in SQLite (views / CTEs filtered by \`requester_user_id\`)

## Acceptance criteria
- [ ] Role assignment UI in web dashboard
- [ ] REST endpoints respect role; return 403 on permission failure
- [ ] MCP tools surface a permission error when caller lacks access
- [ ] Workspace membership as first-class concept
- [ ] Migration path for existing single-user data" \
  '["enhancement","security","enterprise","auth"]'

create_issue \
  "Encryption at rest for the SQLite database and vector store" \
  "## Problem
The SQLite database (including document content, chunk text, and embeddings) is stored in plaintext on disk. Regulated industries (healthcare, finance, legal) require encryption at rest.

## Proposed solution
- Integrate **SQLCipher** (SQLite encryption extension) for AES-256-CBC / AES-256-CTR at-rest encryption
- Key derivation via PBKDF2-HMAC-SHA512 (configurable iterations ≥ 256k)
- Key management integrations: **AWS KMS**, **Azure Key Vault**, **HashiCorp Vault**, local keyfile
- Encrypt \`~/.libscope/\` config files storing connector tokens
- Encrypted exports (\`libscope export --encrypt --key-id=arn:aws:kms:…\`)

## Acceptance criteria
- [ ] Transparent encryption: existing queries work unmodified
- [ ] Key rotation without plaintext exposure
- [ ] CLI \`libscope db encrypt / decrypt\` commands
- [ ] Automated test: DB file is not grep-able for plaintext document content" \
  '["enhancement","security","enterprise","compliance"]'

create_issue \
  "Comprehensive audit logging (who did what, when, to which document)" \
  "## Problem
Enterprise compliance (SOC 2, ISO 27001, HIPAA, GDPR) demands tamper-evident records of every data access and modification. Today libscope has zero audit trail.

## Proposed solution
- Append-only \`audit_log\` table (id, timestamp, user_id, session_id, action, resource_type, resource_id, ip_address, user_agent, outcome, diff_summary)
- Capture: **auth events** (login, logout, failed attempts), **data events** (read, create, update, delete), **admin events** (role changes, connector config, webhook changes)
- Configurable retention policy (e.g. keep 2 years, auto-archive to S3)
- REST endpoint \`GET /api/audit\` with filters (user, date range, action type)
- CLI \`libscope audit export --format=csv --since=2025-01-01\`
- Optional forward to SIEM (syslog / HTTP sink)

## Acceptance criteria
- [ ] Every API endpoint produces a corresponding audit record
- [ ] Audit log is NOT modifiable via any user-facing API
- [ ] Audit export passes hash-chain integrity check
- [ ] Retention purge runs as scheduled job with configurable horizon" \
  '["enhancement","enterprise","compliance","observability"]'

# ── Scalability ───────────────────────────────────────────────────────────────

create_issue \
  "PostgreSQL (+ pgvector) backend as an alternative to SQLite" \
  "## Problem
SQLite is excellent for single-user local deployments but cannot handle:
- Concurrent writes from multiple users
- Knowledge bases >10 GB
- Multi-node / Kubernetes deployments
- Connection pooling

Enterprise teams running shared instances hit write-locking and corruption under load.

## Proposed solution
- Introduce a database abstraction layer (repository pattern) so core logic is DB-agnostic
- Implement a **PostgreSQL** adapter using \`pg\` (Node) or \`pgx\` (Go SDK)
- Use **pgvector** extension for vector similarity (cosine / inner-product) replacing sqlite-vec
- Use **PgBouncer** or built-in \`pg\` pool for connection management
- Migration tool: \`libscope db migrate --from=sqlite --to=postgres --dsn=…\`
- Keep SQLite as default for zero-config local use; Postgres for multi-user/cloud

## Acceptance criteria
- [ ] All 30+ REST endpoints pass integration tests against Postgres
- [ ] Vector search returns identical results (within floating-point tolerance) on both backends
- [ ] p99 write latency <50ms under 50 concurrent users on t3.medium Postgres
- [ ] One-command migration with progress bar and rollback on error" \
  '["enhancement","enterprise","scalability","database"]'

create_issue \
  "Horizontal scaling: Redis-backed caching and distributed rate limiting" \
  "## Problem
When libscope is deployed across multiple processes/containers (load-balanced), the in-process rate limiter and search cache are per-instance. Rate limits can be trivially circumvented by hitting different nodes, and popular queries are re-embedded on every node.

## Proposed solution
- **Redis** integration for:
  - Distributed sliding-window rate limiting (per API key / per user)
  - Shared embedding cache (hash(text+model) → vector) with configurable TTL
  - Shared search analytics (hot documents, search frequency)
  - Distributed lock for scheduled connector syncs (prevent double-run)
- Configuration: \`LIBSCOPE_REDIS_URL=redis://…\` (optional; falls back to in-process)
- Redis Cluster support for HA

## Acceptance criteria
- [ ] Rate limits respected across N instances in Docker Compose test
- [ ] Cache hit reduces embedding latency by ≥ 80% on repeated queries
- [ ] Distributed lock prevents duplicate connector sync across nodes
- [ ] Graceful degradation when Redis is unavailable (fall back to local)" \
  '["enhancement","enterprise","scalability","performance"]'

create_issue \
  "High-availability deployment: replication, backup, and health checks" \
  "## Problem
libscope is a single point of failure. There are no backup schedules, no health probes beyond a basic \`/api/health\`, and no documented recovery procedure.

## Proposed solution
- **Automated backups**: scheduled \`libscope export\` to S3/GCS/Azure Blob with configurable cadence + retention
- **Point-in-time recovery** using SQLite WAL snapshots or Postgres WAL streaming
- **Health/readiness endpoints** (\`/api/health/live\`, \`/api/health/ready\`) with dependency checks (DB, vector store, embedding provider)
- **Kubernetes manifests**: Deployment + HPA, PodDisruptionBudget, liveness/readiness probes, PVC for data
- **Docker Compose HA** example with Postgres + Redis + 2 libscope replicas + nginx

## Acceptance criteria
- [ ] \`/api/health/ready\` returns 503 until DB migrations complete
- [ ] Backup runs on cron, uploads to configurable bucket, sends alert on failure
- [ ] K8s example survives rolling restart with zero query failures in integration test
- [ ] Restore procedure documented and tested (RTO < 30 min)" \
  '["enhancement","enterprise","devops","scalability"]'

# ── Developer / API Experience ────────────────────────────────────────────────

create_issue \
  "Per-user / per-API-key rate limiting with configurable tiers" \
  "## Problem
The current rate limiter is IP-based with a single global limit. Enterprise API consumers need:
- Per API-key limits (bronze/silver/gold tiers)
- Per-user limits independent of API key
- Burst allowance with token-bucket semantics
- \`Retry-After\` and \`X-RateLimit-*\` response headers

## Proposed solution
- Replace IP sliding-window with a **token-bucket per (user_id OR api_key_id)** implemented in Redis
- Admin-configurable limits per tier: requests/min, requests/day, burst
- Return standard \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\`, \`X-RateLimit-Reset\` headers on every response
- \`429 Too Many Requests\` with \`Retry-After\` header
- Exempt paths: \`/api/health/*\`

## Acceptance criteria
- [ ] API key A at tier gold is not throttled by API key B at tier bronze hitting limits
- [ ] Burst: allows 2× limit for first 5s of each minute
- [ ] Admin endpoint to query current usage: \`GET /api/admin/rate-limits\`
- [ ] Load test script demonstrates correct 429 behavior" \
  '["enhancement","enterprise","api","security"]'

create_issue \
  "Webhook security: request signing, IP allowlisting, and mTLS support" \
  "## Problem
Webhooks currently use HMAC-SHA256 signing for outbound payloads, but there is no inbound verification for webhooks (e.g., from Notion, Confluence, Slack pushing changes). Additionally, there is no IP allowlisting or mutual TLS for high-security integrations.

## Proposed solution
- **Inbound webhook verification**: validate signatures from Notion, Slack, Confluence per their published signing schemes
- **IP allowlisting**: per-webhook configurable CIDR list; reject connections outside allowlist
- **mTLS support**: webhook destinations can require client certificate (enterprise internal services)
- **Retry with exponential backoff**: on delivery failure, retry up to N times with jitter
- **Webhook delivery log**: per-webhook history of deliveries with status, response time, response body

## Acceptance criteria
- [ ] Incoming connector webhooks with invalid signatures return 401
- [ ] IP not in allowlist returns 403 before any processing
- [ ] mTLS: libscope presents client cert when configured
- [ ] Delivery log queryable: \`GET /api/webhooks/:id/deliveries\`" \
  '["enhancement","enterprise","security","integrations"]'

# ── Observability ─────────────────────────────────────────────────────────────

create_issue \
  "OpenTelemetry metrics and distributed tracing" \
  "## Problem
libscope emits structured logs (pino) but has no metrics or distributed traces. Enterprise ops teams use Datadog, New Relic, Grafana/Prometheus, or Honeycomb to monitor services. Without OTEL, libscope is a black box.

## Proposed solution
- Integrate **@opentelemetry/sdk-node** with auto-instrumentation
- **Metrics** (via OTEL Metrics API → Prometheus exporter):
  - \`libscope_documents_total\` (gauge, by library/workspace)
  - \`libscope_search_duration_seconds\` (histogram, by search type)
  - \`libscope_rag_latency_seconds\` (histogram, by LLM provider)
  - \`libscope_embedding_cache_hit_ratio\` (gauge)
  - \`libscope_connector_sync_errors_total\` (counter, by connector)
- **Traces**: instrument HTTP handlers, DB queries, embedding calls, LLM calls
- **Log correlation**: inject \`trace_id\` / \`span_id\` into pino log lines
- Exporters: OTLP (gRPC/HTTP) to any OTEL collector; Prometheus scrape endpoint at \`/metrics\`

## Acceptance criteria
- [ ] \`/metrics\` endpoint returns Prometheus text format
- [ ] Traces visible in Jaeger all-in-one Docker image (integration test)
- [ ] Zero performance regression (p99 search latency within 5% of baseline)
- [ ] \`OTEL_EXPORTER_OTLP_ENDPOINT\` env var wires up the exporter" \
  '["enhancement","enterprise","observability","devops"]'

# ── Compliance ────────────────────────────────────────────────────────────────

create_issue \
  "Data residency, retention policies, and right-to-erasure (GDPR)" \
  "## Problem
Enterprise customers in EU, APAC, and regulated US sectors need:
- Documents stored in a specific geographic region
- Automated data expiry based on age or classification
- The ability to provably delete all data associated with a user (GDPR Art. 17)

## Proposed solution
- **Retention policies**: configurable per-library (e.g. \`max_age: 365d\`); scheduler auto-deletes expired docs with audit record
- **Right to erasure**: \`DELETE /api/users/:id/data\` hard-deletes documents, chunks, embeddings, audit log entries (replaces with tombstone), and regenerates API keys belonging to the user
- **Data residency tags**: documents tagged with \`data_region: eu | us | apac\`; query filter ensures cross-region data never returned in wrong-region deployment
- **Export**: \`GET /api/users/:id/export\` returns GDPR-compliant data package

## Acceptance criteria
- [ ] Retention job deletes docs past expiry with audit trail entry
- [ ] Erasure endpoint returns 204 and subsequent search returns zero results for erased user's documents
- [ ] Data residency filter enforced at query layer (not application layer)
- [ ] Integration test verifies no PII in DB after erasure" \
  '["enhancement","enterprise","compliance","gdpr"]'

create_issue \
  "Admin dashboard: user management, system health, and usage analytics" \
  "## Problem
There is no admin interface for managing users, monitoring system health, or viewing usage across workspaces. Admins must use raw API calls or direct database access.

## Proposed solution
Extend the existing web dashboard with a protected \`/admin\` section:

**User Management tab**
- List users, roles, last-active timestamp
- Invite via email (SMTP / SendGrid integration)
- Reset password, revoke sessions, lock account

**System Health tab**
- Real-time metrics: CPU, memory, disk, DB size, embedding queue depth
- Connector sync status (last run, next run, error rate)
- Service dependency health (embedding provider, LLM, Redis, Postgres)

**Usage Analytics tab**
- Documents per workspace / library (chart)
- Search volume over time
- Top queried topics / tags
- API key usage breakdown
- Storage consumption by library

## Acceptance criteria
- [ ] Admin routes protected at middleware level (Admin role only)
- [ ] Invite flow sends email and creates pending-activation user
- [ ] Metrics panel auto-refreshes every 30s via SSE or polling
- [ ] All charts exportable as CSV" \
  '["enhancement","enterprise","admin","ux"]'

create_issue \
  "Multi-tenant workspace isolation with resource quotas" \
  "## Problem
Workspaces today share the same SQLite instance and have no enforced resource limits. A runaway sync job in workspace A can consume all disk I/O and disk space, affecting workspace B.

## Proposed solution
- **True namespace isolation**: each workspace has its own schema prefix (SQLite) or schema (Postgres) — no cross-workspace query leakage even with SQL injection
- **Resource quotas** (configurable by Admin):
  - Max documents per workspace
  - Max storage (MB) per workspace
  - Max API requests/day per workspace
  - Max concurrent connector syncs per workspace
- **Quota enforcement**: writes return 429 with \`X-Quota-Remaining\` header when limit hit
- **Quota dashboard**: current usage vs. limit per workspace in admin UI

## Acceptance criteria
- [ ] Workspace A SQL injection cannot access workspace B data (penetration test)
- [ ] Document write blocked at quota limit with informative error
- [ ] Admin can adjust quota without restarting server
- [ ] \`GET /api/admin/workspaces/:id/quota\` returns usage + limits" \
  '["enhancement","enterprise","security","scalability"]'

create_issue \
  "Enterprise connector: Microsoft SharePoint & OneDrive sync" \
  "## Problem
SharePoint and OneDrive are the most widely deployed document stores in enterprises. They are conspicuously absent from libscope's connector list, making it a hard sell to Microsoft-heavy organizations.

## Proposed solution
- **SharePoint Online connector**: sync sites, document libraries, lists (filtering by content type)
- **OneDrive for Business**: sync personal/shared drives by folder path
- Auth: OAuth 2.0 device code flow (no browser needed in CLI) + service principal for server-side
- Incremental sync via SharePoint \`/delta\` API
- Respect file permissions: only index documents the authed user can read
- Support: .docx, .xlsx (convert to CSV/text), .pptx (slide text), .pdf, .md

## Acceptance criteria
- [ ] \`libscope connect sharepoint --site=https://company.sharepoint.com/sites/Eng\`
- [ ] Incremental delta sync runs in < 2s for unchanged content
- [ ] File permissions respected: test user cannot find documents they don't have SharePoint access to
- [ ] Reconnect on token expiry with refresh-token flow" \
  '["enhancement","enterprise","connectors","integrations"]'

create_issue \
  "SOC 2 / ISO 27001 compliance readiness report and hardening checklist" \
  "## Problem
Enterprise security and procurement teams request SOC 2 Type II or ISO 27001 attestation before approving software. libscope has no compliance documentation, trust report, or hardening guide.

## Proposed solution
- **Hardening guide** (docs): production deployment checklist (TLS, auth, encryption, network egress, secrets management)
- **Compliance controls mapping**: document which libscope features map to SOC 2 Trust Service Criteria (CC6, CC7, CC9) and ISO 27001 Annex A controls
- **Automated compliance checks**: \`libscope compliance check\` command that verifies:
  - API key auth enabled
  - TLS configured
  - Audit logging enabled
  - Encryption at rest enabled
  - Rate limiting active
  - Webhook signing enabled
- **Dependency vulnerability scanning**: integrate \`npm audit\` and Snyk into CI; fail build on high/critical CVE
- **Penetration testing**: document scope and engage a third-party pentest; publish summary report

## Acceptance criteria
- [ ] \`libscope compliance check\` exits non-zero with clear remediation steps if any control fails
- [ ] Controls mapping document in \`docs/compliance/\`
- [ ] Snyk scan passes (zero high/critical) in CI
- [ ] Hardening guide covers all connector token storage, TLS termination, reverse proxy setup" \
  '["enhancement","enterprise","compliance","security","documentation"]'

# =============================================================================
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Done! Milestone #$MILESTONE_NUMBER + 15 issues created."
echo "  https://github.com/$REPO/milestone/$MILESTONE_NUMBER"
echo "════════════════════════════════════════════════════════════"
