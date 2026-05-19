# AGENTS.md
Read CLAUDE.md as well.

## Project: Mailbridge

Mailbridge is a Node.js mail bridge that connects Cloudflare Email Workers to a private/local SMTP server for inbound mail and can also relay trusted outbound SMTP traffic to provider APIs.

This repository contains backend runtime code, Cloudflare edge code, middleware-style processing modules, Docker packaging, and tests. It does not contain a browser frontend.

## Codebase Map

```text
.
├── server.js                 # Main Node.js backend service
├── worker.js                 # Cloudflare Worker edge entrypoint
├── entrypoint.sh             # Container startup script
├── Dockerfile                # Container image definition
├── docker-compose.yml        # Local/runtime compose definition
├── package.json              # Node metadata, dependencies, scripts
├── lib/                      # Backend modules and mail-processing middleware
├── test/                     # Node test suite
├── data/                     # Runtime audit DB and encrypted local queue data; not committed
└── secrets/                  # Runtime private key and queue-secret DB; not committed
```

## Backend

The backend is the Node.js service started by:

```bash
npm start
```

The package entrypoint is:

```text
server.js
```

The backend uses:

- Express for the HTTP webhook and health endpoint
- smtp-server for the optional local SMTP relay
- nodemailer for local SMTP delivery
- sqlite3 for audit and queue metadata
- mailparser and provider-specific modules for outbound preparation
- OpenAI SDK only when optional AI classification is enabled

### Backend responsibilities

`server.js` wires together the runtime:

- loads `.env`
- starts the HTTP listener on `PORT`, default `3090`
- exposes `GET /health`
- exposes `POST /api/webhook/email`
- validates `X-Webhook-Secret`
- decrypts Worker-encrypted inbound payloads
- runs SpamAssassin / optional Spamhaus / optional AI checks
- injects Exchange-friendly spam headers
- delivers inbound mail to `LOCAL_MAIL_HOST:LOCAL_MAIL_PORT`
- queues temporary inbound failures
- optionally starts the SMTP relay on `SMTP_RELAY_PORT`, default `2525`
- relays outbound mail through SendGrid, Resend, Mailgun, or Cloudflare Email Service
- queues temporary outbound provider failures

## Cloudflare Edge Code

`worker.js` is the Cloudflare Worker.

It implements three Worker handlers:

```js
fetch(request, env, ctx)
email(message, env, ctx)
queue(batch, env, ctx)
```

### Worker `email()` handler

The `email()` handler receives Cloudflare Email Routing messages. It:

1. reads the raw message
2. extracts envelope metadata
3. encrypts the payload using `MAILBRIDGE_PUBLIC_KEY_PEM`
4. stores ciphertext in R2 through `MAIL_STORE`
5. enqueues an object reference through `MAIL_QUEUE`

### Worker `queue()` handler

The `queue()` handler:

1. reads object references from Cloudflare Queue
2. loads the encrypted object from R2
3. POSTs the encrypted payload to Mailbridge at `NODE_APP_URL`
4. deletes the R2 object after successful delivery
5. retries temporary failures
6. deletes/acks permanent failures after logging

### Worker `fetch()` handler

The `fetch()` handler exposes:

```text
POST /api/send/email
```

This is used only for Cloudflare Email Service outbound relay. It verifies the shared webhook secret and sends through:

```js
env.EMAIL.send(...)
```

## Middleware and Processing Modules

The `lib/` directory contains most processing modules. Treat these as composable backend middleware, even when they are not Express middleware.

Important module categories:

### Webhook intake

- validates inbound webhook requests
- checks shared secret
- normalizes payload shape

### Inbound cryptography

- decrypts Worker-encrypted R2 payloads
- uses the Mailbridge private key from `MAILBRIDGE_PRIVATE_KEY_PATH`

### Queue cryptography and persistence

- encrypts local retry queue files
- stores per-message secret material in `secrets/secrets.db`
- stores queue files under `data/queue/`
- keeps audit data in `data/mailbridge.db`

### Spam pipeline

- runs SpamAssassin or Postmark SpamCheck mode
- parses signed SpamAssassin scores, including negative ham scores
- checks GTUBE
- applies SCL-style spam headers
- optionally subject-tags spam

### Reputation checks

- optional Spamhaus sender-IP/domain checks
- uses original sender metadata passed from the Worker where available

### AI classification

- optional OpenAI-compatible classifier
- intended as secondary/fallback screening
- should remain disabled by default

### Local mail transport

- sends accepted inbound mail to the configured local SMTP server
- supports TLS and local CA configuration

### SMTP relay

- optional trusted relay listener
- CIDR-gated
- supports STARTTLS requirements
- accepts local SMTP and forwards to configured upstream provider

### Upstream provider delivery

- SendGrid
- Resend
- Mailgun
- Cloudflare Email Service Worker endpoint

## Frontend

There is no frontend application in this repository.

No React, Vue, Svelte, Next.js, mobile app, or browser UI is present.

Cloudflare dashboard configuration, Worker routes, Email Routing, Queue, R2, and Email Service bindings are configured externally or via `wrangler.toml`.

## Runtime Services

A typical deployment includes:

- Mailbridge container
- local or private SMTP server
- Cloudflare Email Routing
- Cloudflare Worker
- Cloudflare R2 bucket
- Cloudflare Queue
- optional Cloudflare Email Service binding
- optional Cloudflare Tunnel
- optional Spamhaus API
- optional AI provider

## Environment Files

`.env` is required for local/container runtime and must not be committed.

`.env.example` should contain safe placeholders only.

Sensitive values include:

- `WEBHOOK_SECRET`
- `QUEUE_MASTER_KEY`
- `CLOUDFLARE_SEND_WEBHOOK_SECRET`
- `CLOUDFLARED_TUNNEL_TOKEN`
- `RELAY_API_KEY`
- `AI_API_KEY`
- `SPAMHAUS_USERNAME`
- `SPAMHAUS_PASSWORD`
- private keys under `secrets/`

## Wrangler

`wrangler.toml` may be committed only if it contains generic placeholders.

Safe public example:

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

Do not commit account IDs, custom live hostnames, tokens, private keys, or real secrets.

## Build and Run Commands

Install dependencies:

```bash
npm install
```

Run locally:

```bash
npm start
```

Run tests:

```bash
npm test
```

Build and run container:

```bash
docker compose up -d --build
```

Tail logs:

```bash
docker logs -f mail-bridge
```

Deploy Worker:

```bash
npx wrangler deploy
```

Upload secrets:

```bash
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put MAILBRIDGE_PUBLIC_KEY_PEM
npx wrangler secret put CLOUDFLARE_SEND_WEBHOOK_SECRET
```

## Testing Expectations

Before changing behavior, run:

```bash
npm test
```

For Docker/runtime changes, also run:

```bash
docker compose up -d --build
docker logs -f mail-bridge
```

For Worker changes, validate:

```bash
npx wrangler deploy --dry-run
```

or deploy to a non-production Worker first.

## Development Guidelines for Agents

### Do

- Keep `.env.example` safe and generic.
- Keep `.env` out of git.
- Keep `secrets/` and `data/` out of git.
- Preserve encrypted-at-rest behavior for queued mail.
- Preserve R2 ciphertext-only behavior.
- Preserve local private key ownership of R2 decryption.
- Preserve webhook secret validation.
- Preserve CIDR protections around the SMTP relay.
- Prefer fail-closed behavior for spam filter failures unless explicitly configured otherwise.
- Add or update tests when changing parsing, crypto, queue, spam, webhook, or provider behavior.

### Do not

- Commit live secrets.
- Log full raw email contents unnecessarily.
- Log private keys or queue master keys.
- Disable webhook authentication.
- Make the SMTP relay open by default.
- Store plaintext queued mail on disk.
- Store plaintext inbound mail in R2.
- Assume Docker Desktop host IPs are the same as Linux Docker bridge IPs.
- Put `send_email = [...]` inside a queue consumer block in `wrangler.toml`.

## Common Gotchas

### SMTP relay listening in container but not on host

If `swaks` gets connection refused on `127.0.0.1:2525`, check whether Docker published the port:

```bash
docker compose ps
```

### SMTP relay connection denied

If logs show a source like `192.168.65.1`, add the correct Docker Desktop CIDR to `SMTP_RELAY_ALLOWED_CIDRS`.

### Cloudflare outbound DNS failure

If logs show `getaddrinfo ENOTFOUND postmaster.example.com`, the container cannot resolve `CLOUDFLARE_SEND_WORKER_URL`. Use the deployed `workers.dev` URL until custom DNS is correct.

### Missing `env.EMAIL`

If Wrangler deploy output does not show `env.EMAIL`, the Cloudflare Email Service binding is not configured. Use top-level:

```toml
[[send_email]]
name = "EMAIL"
```

## Security Posture

This project handles email, including potentially sensitive content. Treat it as security-sensitive infrastructure.

Default posture should be:

- inbound webhook authenticated
- R2 encrypted with public-key envelope encryption
- private key only on Mailbridge
- local retry queue encrypted
- SMTP relay disabled unless intentionally enabled
- SMTP relay CIDR restricted
- TLS preferred for local mail delivery
- optional AI disabled unless approved
- optional Spamhaus disabled unless configured correctly
