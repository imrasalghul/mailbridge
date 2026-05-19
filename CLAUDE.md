# CLAUDE.md

## Purpose

This file gives Claude Code and other coding agents concise instructions for working on Mailbridge.

Mailbridge is a Node.js + Cloudflare Worker mail bridge. It receives inbound mail from Cloudflare Email Routing, stores encrypted handoff objects in R2, uses Cloudflare Queues for delivery, and forwards accepted mail to a local/private SMTP server. It can also expose a trusted SMTP relay that sends outbound mail through Cloudflare Email Service or Resend.

## High-Level Architecture

```text
Inbound:
Cloudflare Email Routing
-> worker.js email()
-> encrypted R2 object
-> Cloudflare Queue
-> worker.js queue()
-> POST /api/webhook/email on Mailbridge
-> server.js spam/reputation/AI pipeline
-> local SMTP server

Outbound:
trusted SMTP client
-> server.js SMTP relay
-> Cloudflare Email Service or Resend delivery module
-> recipient
```

## Main Files

- `server.js` — main backend service.
- `worker.js` — Cloudflare Worker for inbound email, queue processing, and Cloudflare Email Service send endpoint.
- `entrypoint.sh` — container startup script. Starts SpamAssassin and optional `cloudflared`.
- `Dockerfile` — image definition.
- `docker-compose.yml` — local/container runtime definition.
- `lib/` — processing modules.
- `test/` — Node test suite.
- `.env.example` — safe environment template.

## Runtime

The backend starts with:

```bash
npm start
```

Tests run with:

```bash
npm test
```

Docker runtime:

```bash
docker compose up -d --build
```

Worker deploy:

```bash
npx wrangler deploy
```

## Important Behavior to Preserve

### Inbound

- The Worker must store encrypted R2 objects, not plaintext raw mail.
- The Worker must enqueue object references, not raw plaintext mail.
- Mailbridge must validate `X-Webhook-Secret`.
- Mailbridge must decrypt inbound payloads locally with the private key.
- Mailbridge must preserve local delivery to `LOCAL_MAIL_HOST:LOCAL_MAIL_PORT`.
- Temporary local delivery failures should queue and retry.
- Permanent local SMTP failures should not retry forever.

### Outbound

- SMTP relay must remain disabled by default.
- SMTP relay must be CIDR-gated.
- SMTP relay must support Cloudflare Email Service and Resend provider selection.
- Temporary upstream failures should queue and retry.
- Cloudflare outbound must call the Worker `/api/send/email` endpoint.
- The Worker must verify the webhook secret before calling `env.EMAIL.send(...)`.

### Security

Do not commit or print:

- `.env`
- private keys
- queue master keys
- tunnel tokens
- provider API keys
- Worker secrets
- contents of `secrets/`
- contents of `data/`

Do not remove:

- webhook secret validation
- queue encryption
- R2 encryption
- SMTP relay allowlist checks
- private-key-only R2 decryption design

## Public Repo Requirements

Safe to commit:

- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `.env.example`
- generic `wrangler.toml`
- source code
- tests

Not safe to commit:

- live `.env`
- real `wrangler.toml` with account-specific or production values
- private keys
- real tunnel tokens
- real API keys
- real webhook secrets
- runtime database files
- runtime queued mail files

Recommended `.gitignore`:

```gitignore
.env
.env.*
!.env.example

data/
secrets/
*.pem
*.key
*.crt
*.csr
*.p12

node_modules/
.wrangler/
```

## `wrangler.toml` Rules

Use top-level Cloudflare Email Service syntax:

```toml
[[send_email]]
name = "EMAIL"
```

Do not place `send_email = [...]` inside `[[queues.consumers]]`.

Generic public example:

```toml
name = "mailbridge-worker"
main = "worker.js"
compatibility_date = "2026-05-19"
preview_urls = false

[vars]
NODE_APP_URL = "https://mailbridge.example.com/api/webhook/email"
MAIL_STORE_ENCRYPTION_VERSION = "v1"

[[r2_buckets]]
binding = "MAIL_STORE"
bucket_name = "mailbridge-inbound"

[[queues.producers]]
binding = "MAIL_QUEUE"
queue = "mailbridge-inbound"

[[queues.consumers]]
queue = "mailbridge-inbound"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 3

[[send_email]]
name = "EMAIL"
```

## Environment Rules

`.env.example` must be generic. Real `.env` must be local only.

Important runtime variables:

- `WEBHOOK_SECRET`
- `QUEUE_MASTER_KEY`
- `MAILBRIDGE_PRIVATE_KEY_PATH`
- `LOCAL_MAIL_HOST`
- `LOCAL_MAIL_PORT`
- `RELAY_UPSTREAM_PROVIDER`
- `SMTP_RELAY_ENABLED`
- `SMTP_RELAY_ALLOWED_CIDRS`
- `CLOUDFLARE_SEND_WORKER_URL`
- `CLOUDFLARE_SEND_WEBHOOK_SECRET`
- `SPAMASSASSIN_MODE`

## Testing Checklist

After backend changes:

```bash
npm test
```

After Docker/startup changes:

```bash
docker compose up -d --build
docker logs -f mail-bridge
```

After Worker changes:

```bash
npx wrangler deploy --dry-run
```

or deploy to a staging Worker.

After SMTP relay changes:

```bash
swaks \
  --server 127.0.0.1 \
  --port 2525 \
  --from postmaster@example.com \
  --to recipient@example.net \
  --header "Subject: Mailbridge outbound test" \
  --body "This is an outbound relay test through Mailbridge."
```

After inbound changes, expected successful logs include:

```text
[Webhook] Inbound payload accepted ...
[SpamAssassin] Score resolved ...
[Webhook] Injected inbound local-mail headers ...
Direct delivery successful.
```

## Common Debug Notes

### Port 2525 connection refused

Docker may not be publishing the relay port. Check:

```bash
docker compose ps
```

Expected when relay is exposed:

```text
0.0.0.0:2525->2525/tcp
```

### Relay connection not allowed

The source IP is not in `SMTP_RELAY_ALLOWED_CIDRS`.

On Docker Desktop for macOS, host-originated connections may appear as:

```text
192.168.65.1
```

Add:

```dotenv
SMTP_RELAY_ALLOWED_CIDRS=192.168.65.0/24,127.0.0.1/32
```

plus the LAN CIDR if needed.

### Cloudflare outbound DNS failure

If logs show:

```text
getaddrinfo ENOTFOUND postmaster.example.com
```

then the container cannot resolve `CLOUDFLARE_SEND_WORKER_URL`. Use the deployed `workers.dev` endpoint until the custom hostname resolves.

### Missing `env.EMAIL`

If Wrangler output does not list `env.EMAIL`, fix the `[[send_email]]` binding.

## Code Style

- Keep code explicit and operationally clear.
- Prefer small modules under `lib/`.
- Preserve existing logging style.
- Avoid logging full raw mail unless necessary for a test fixture.
- Add tests for parser, crypto, queue, spam, and provider changes.
- Keep defaults conservative and safe.
- Document new environment variables in `.env.example` and `README.md`.

## No Frontend

This repo has no frontend. Do not add UI dependencies or browser app structure unless explicitly requested.

Configuration is done through:

- `.env`
- `wrangler.toml`
- Cloudflare dashboard
- Docker Compose
