# Mailbridge

Mailbridge bridges Cloudflare Email Workers to a local mail server for inbound mail, and can relay trusted SMTP traffic to SendGrid, Resend, Mailgun, or Cloudflare Email Service for outbound mail.

## Overview

Mailbridge is designed for hybrid mail deployments where Cloudflare handles public inbound email routing while final mail delivery still happens on a private or local mail server.

### Inbound flow

```text
Sender
-> Cloudflare Email Routing / Email Worker
-> encrypted R2 object
-> Cloudflare Queue
-> Mailbridge webhook
-> SpamAssassin / optional reputation checks / optional AI checks
-> local mail server
```

### Outbound flow

```text
Trusted SMTP client
-> Mailbridge SMTP relay
-> selected upstream provider API
-> recipient
```

Supported outbound providers:

- SendGrid
- Resend
- Mailgun
- Cloudflare Email Service

## Key Features

- HTTP webhook intake for Cloudflare Email Workers
- Cloudflare Queue based inbound delivery
- Encrypted R2-backed inbound mail handoff
- Local mail delivery to Exchange, Postfix, Haraka, Mailcow, or another SMTP server
- Optional SMTP relay for trusted local systems
- Outbound relay support for SendGrid, Resend, Mailgun, or Cloudflare Email Service
- Multi-layer inbound filtering with SpamAssassin and optional AI review
- Local SpamAssassin daemon mode or Postmark SpamCheck mode
- Optional Spamhaus sender-IP and sender-domain reputation checks
- Exchange-friendly spam headers and subject tagging
- Encrypted file-backed retry queue for temporary delivery failures
- Audit-only SQLite database at `data/mailbridge.db`
- Separate queue-secrets database at `secrets/secrets.db`
- Public-key encryption for mail stored in R2 so only Mailbridge can decrypt it
- Optional in-container `cloudflared` tunnel for publishing the webhook without directly exposing port `3090`

## Repository Layout

```text
.
├── Dockerfile
├── docker-compose.yml
├── entrypoint.sh
├── worker.js
├── server.js
├── lib/
├── test/
├── .env.example
└── README.md
```

`worker.js` is the Cloudflare Worker entrypoint.

`server.js` is the Mailbridge Node.js service.

## Quick Start

Pull the published container:

```bash
docker pull ghcr.io/imrasalghul/mailbridge
```

Create local config and runtime directories:

```bash
cp .env.example .env
mkdir -p data/queue secrets
```

Generate the local queue master key:

```bash
openssl rand -base64 32 | tr -d '\n'
```

Set the output as:

```dotenv
QUEUE_MASTER_KEY=...
```

Generate the Mailbridge private/public key pair used for encrypted R2-backed inbound mail:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out secrets/mailbridge-r2-private.pem

openssl rsa -pubout \
  -in secrets/mailbridge-r2-private.pem \
  -out secrets/mailbridge-r2-public.pem

chmod 600 secrets/mailbridge-r2-private.pem
```

Keep the private key on the Mailbridge host only.

Copy the public key into the Cloudflare Worker secret:

```bash
cat secrets/mailbridge-r2-public.pem
```

Set the copied value as:

```text
MAILBRIDGE_PUBLIC_KEY_PEM
```

## Bootstrap Configuration

For a new deployment, the easiest setup path is:

1. Export a few deployment-specific values.
2. Generate local secrets and the R2 encryption key pair.
3. Auto-write `.env`.
4. Auto-write `wrangler.toml`.
5. Upload Worker secrets with Wrangler.
6. Deploy the Worker.
7. Start Mailbridge.

Do not commit `.env`, private keys, tunnel tokens, or live Worker secrets.

### 1. Set deployment variables

Run this from the Mailbridge repo root and edit the values for your environment:

```bash
export MAILBRIDGE_HOSTNAME="mailbridge.example.com"
export WORKER_NAME="mailbridge-worker"
export WORKER_SEND_URL="https://${WORKER_NAME}.example.workers.dev/api/send/email"

export LOCAL_MAIL_HOST="mail.internal.example"
export LOCAL_MAIL_PORT="25"

export RELAY_UPSTREAM_PROVIDER="cloudflare"
export RELAY_FROM_FALLBACK="postmaster@example.com"

export SMTP_RELAY_ENABLED="false"
export SMTP_RELAY_ALLOWED_CIDRS="127.0.0.1/32,::1/128"

export CLOUDFLARED_ENABLED="false"
export CLOUDFLARED_TUNNEL_TOKEN=""

export R2_BUCKET_NAME="mailbridge-inbound"
export QUEUE_NAME="mailbridge-inbound"
```

For a LAN relay, use something like:

```bash
export SMTP_RELAY_ENABLED="true"
export SMTP_RELAY_ALLOWED_CIDRS="192.168.1.0/24,127.0.0.1/32"
```

If testing from Docker Desktop on macOS, the relay client may appear as `192.168.65.1`, so include:

```bash
export SMTP_RELAY_ALLOWED_CIDRS="192.168.1.0/24,192.168.65.0/24,127.0.0.1/32"
```

If the container runs `cloudflared`, set:

```bash
export CLOUDFLARED_ENABLED="true"
export CLOUDFLARED_TUNNEL_TOKEN="your_tunnel_token"
```

If `cloudflared` runs as a host service instead, keep `CLOUDFLARED_ENABLED=false`.

### 2. Generate secrets and write `.env`

Run this from the Mailbridge repo root:

```bash
mkdir -p data/queue secrets

export QUEUE_MASTER_KEY="${QUEUE_MASTER_KEY:-$(openssl rand -base64 32 | tr -d '\n')}"
export WEBHOOK_SECRET="${WEBHOOK_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}"
export CLOUDFLARE_SEND_WEBHOOK_SECRET="${CLOUDFLARE_SEND_WEBHOOK_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}"

if [ ! -f secrets/mailbridge-r2-private.pem ]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
    -out secrets/mailbridge-r2-private.pem

  openssl rsa -pubout \
    -in secrets/mailbridge-r2-private.pem \
    -out secrets/mailbridge-r2-public.pem

  chmod 600 secrets/mailbridge-r2-private.pem
fi

cat > .env <<EOF
# Node App Configuration
PORT=3090
SMTP_RELAY_PORT=2525
SMTP_RELAY_SOCKET_TIMEOUT_MS=120000
MAILBRIDGE_VERBOSE_LOGGING=true
MAILBRIDGE_HOSTNAME=${MAILBRIDGE_HOSTNAME}
QUEUE_MAX_ATTEMPTS=20
DATA_DIR=/app/data
SECRETS_DB_PATH=/app/secrets/secrets.db
QUEUE_MASTER_KEY=${QUEUE_MASTER_KEY}
MAILBRIDGE_PRIVATE_KEY_PATH=/app/secrets/mailbridge-r2-private.pem
AUDIT_LOG_RETENTION_DAYS=1

# Optional in-container Cloudflare Tunnel
CLOUDFLARED_ENABLED=${CLOUDFLARED_ENABLED}
CLOUDFLARED_TUNNEL_TOKEN=${CLOUDFLARED_TUNNEL_TOKEN}
CLOUDFLARED_LOGLEVEL=info

# Security - must match the Worker secret WEBHOOK_SECRET
WEBHOOK_SECRET=${WEBHOOK_SECRET}

# Local Mail Server Configuration
LOCAL_MAIL_HOST=${LOCAL_MAIL_HOST}
LOCAL_MAIL_PORT=${LOCAL_MAIL_PORT}
LOCAL_MAIL_SECURE=false
LOCAL_MAIL_REQUIRE_TLS=false
LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED=false
LOCAL_MAIL_TLS_SERVERNAME=
LOCAL_MAIL_TLS_CA_FILE=

# Outbound Relay Provider Configuration
RELAY_UPSTREAM_PROVIDER=${RELAY_UPSTREAM_PROVIDER}
RELAY_API_KEY=
RELAY_FROM_FALLBACK=${RELAY_FROM_FALLBACK}
RESEND_BASE_URL=https://api.resend.com
MAILGUN_DOMAIN=
MAILGUN_BASE_URL=https://api.mailgun.net
CLOUDFLARE_SEND_WORKER_URL=${WORKER_SEND_URL}
CLOUDFLARE_SEND_WEBHOOK_SECRET=${CLOUDFLARE_SEND_WEBHOOK_SECRET}

SMTP_RELAY_ENABLED=${SMTP_RELAY_ENABLED}
SMTP_RELAY_VERBOSE_LOGGING=true
SMTP_RELAY_INJECT_HEADERS=true
SMTP_RELAY_REQUIRE_TLS=false
SMTP_RELAY_ALLOW_INSECURE=false
SMTP_RELAY_ALLOWED_CIDRS=${SMTP_RELAY_ALLOWED_CIDRS}
SMTP_RELAY_TLS_CERT_FILE=
SMTP_RELAY_TLS_KEY_FILE=
SMTP_RELAY_TLS_CA_FILE=

# SpamAssassin Config
SPAMASSASSIN_MODE=local
POSTMARK_SPAMCHECK_URL=https://spamcheck.postmarkapp.com/filter
SPAMD_HOST=127.0.0.1
SPAMD_PORT=783
SPAMD_STARTUP_ATTEMPTS=30
SPAMC_TIMEOUT_MS=10000
SPAMC_FAIL_OPEN=false
SA_BLOCK_THRESHOLD=12
SA_QUESTIONABLE_THRESHOLD=5
SPAM_SCL_SCORE=9
SPAM_SUBJECT_TAG=[SPAM]

# Optional Spamhaus Intelligence API checks
SPAMHAUS_ENABLED=false
SPAMHAUS_USERNAME=
SPAMHAUS_PASSWORD=
SPAMHAUS_FAIL_OPEN=true

# Optional AI secondary screening
AI_ENABLED=false
AI_API_KEY=
AI_MODEL=gpt-5.4-nano
AI_BASE_URL=
AI_INPUT_SCOPE=headers
AI_MAX_INPUT_CHARS=20000
EOF

echo
echo "Generated .env"
echo
echo "Worker secrets to upload:"
echo "WEBHOOK_SECRET=${WEBHOOK_SECRET}"
echo "CLOUDFLARE_SEND_WEBHOOK_SECRET=${CLOUDFLARE_SEND_WEBHOOK_SECRET}"
echo
echo "MAILBRIDGE_PUBLIC_KEY_PEM:"
cat secrets/mailbridge-r2-public.pem
```

### 3. Write `wrangler.toml`

Run this from the Mailbridge repo root:

```bash
cat > wrangler.toml <<EOF
name = "${WORKER_NAME}"
main = "worker.js"
compatibility_date = "2026-05-19"
preview_urls = false

[vars]
NODE_APP_URL = "https://${MAILBRIDGE_HOSTNAME}/api/webhook/email"
MAIL_STORE_ENCRYPTION_VERSION = "v1"

[[r2_buckets]]
binding = "MAIL_STORE"
bucket_name = "${R2_BUCKET_NAME}"

[[queues.producers]]
binding = "MAIL_QUEUE"
queue = "${QUEUE_NAME}"

[[queues.consumers]]
queue = "${QUEUE_NAME}"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 3

[[send_email]]
name = "EMAIL"
EOF
```

The `[[send_email]]` block must be top-level. Do not put `send_email = [...]` inside `[[queues.consumers]]`.

### 4. Upload Worker secrets

Run:

```bash
printf '%s' "$WEBHOOK_SECRET" | npx wrangler secret put WEBHOOK_SECRET --name "$WORKER_NAME"

printf '%s' "$CLOUDFLARE_SEND_WEBHOOK_SECRET" | npx wrangler secret put CLOUDFLARE_SEND_WEBHOOK_SECRET --name "$WORKER_NAME"

cat secrets/mailbridge-r2-public.pem | npx wrangler secret put MAILBRIDGE_PUBLIC_KEY_PEM --name "$WORKER_NAME"
```

### 5. Create Cloudflare resources and deploy

Run:

```bash
npx wrangler r2 bucket create "$R2_BUCKET_NAME" || true
npx wrangler queues create "$QUEUE_NAME" || true
npx wrangler deploy
```

After deploy, Wrangler should show bindings similar to:

```text
env.MAIL_QUEUE
env.MAIL_STORE
env.NODE_APP_URL
env.MAIL_STORE_ENCRYPTION_VERSION
env.EMAIL
```

If `env.EMAIL` is missing, check that `wrangler.toml` contains:

```toml
[[send_email]]
name = "EMAIL"
```

### 6. Start Mailbridge

Run:

```bash
docker compose up -d --build
docker compose ps
docker logs -f mail-bridge
```

If using the SMTP relay, make sure port `2525` is published in your local compose override:

```yaml
services:
  mail-bridge:
    ports:
      - "3090:3090"
      - "2525:2525"
```

### 7. Test inbound

Send an email to an address routed to the Cloudflare Worker.

Watch logs:

```bash
docker logs -f mail-bridge
```

Successful inbound delivery looks like:

```text
[Webhook] Inbound payload accepted ...
[SpamAssassin] Score resolved ...
[Webhook] Injected inbound local-mail headers ...
Direct delivery successful.
```

### 8. Test outbound relay

If `SMTP_RELAY_ENABLED=true`, test with `swaks`:

```bash
swaks \
  --server 127.0.0.1 \
  --port 2525 \
  --from postmaster@example.com \
  --to recipient@example.net \
  --header "Subject: Mailbridge outbound test" \
  --body "This is an outbound relay test through Mailbridge."
```

Successful SMTP relay acceptance looks like:

```text
MAIL FROM accepted
RCPT accepted
Received message from local relay client
```

If the upstream provider is unavailable, Mailbridge queues the message for retry.

## Local Configuration Reference

Review `.env.example` before first start.

Minimal inbound-only example:

```dotenv
PORT=3090
MAILBRIDGE_HOSTNAME=mailbridge.example.com
WEBHOOK_SECRET=replace_with_a_shared_secret

LOCAL_MAIL_HOST=mail.internal.example
LOCAL_MAIL_PORT=25
LOCAL_MAIL_REQUIRE_TLS=true
LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED=true

DATA_DIR=/app/data
SECRETS_DB_PATH=/app/secrets/secrets.db
QUEUE_MASTER_KEY=replace_with_a_base64_32_byte_value
MAILBRIDGE_PRIVATE_KEY_PATH=/app/secrets/mailbridge-r2-private.pem
AUDIT_LOG_RETENTION_DAYS=1

SPAMASSASSIN_MODE=local
SPAMHAUS_ENABLED=false
AI_ENABLED=false

SMTP_RELAY_ENABLED=false
```

Example with Cloudflare outbound relay enabled:

```dotenv
PORT=3090
MAILBRIDGE_HOSTNAME=mailbridge.example.com
WEBHOOK_SECRET=replace_with_a_shared_secret

LOCAL_MAIL_HOST=mail.internal.example
LOCAL_MAIL_PORT=25
LOCAL_MAIL_REQUIRE_TLS=false
LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED=false

RELAY_UPSTREAM_PROVIDER=cloudflare
RELAY_API_KEY=
RELAY_FROM_FALLBACK=postmaster@example.com
CLOUDFLARE_SEND_WORKER_URL=https://mailbridge-worker.example.workers.dev/api/send/email
CLOUDFLARE_SEND_WEBHOOK_SECRET=replace_with_worker_send_secret

DATA_DIR=/app/data
SECRETS_DB_PATH=/app/secrets/secrets.db
QUEUE_MASTER_KEY=replace_with_a_base64_32_byte_value
MAILBRIDGE_PRIVATE_KEY_PATH=/app/secrets/mailbridge-r2-private.pem
AUDIT_LOG_RETENTION_DAYS=1

SMTP_RELAY_ENABLED=true
SMTP_RELAY_PORT=2525
SMTP_RELAY_REQUIRE_TLS=false
SMTP_RELAY_ALLOWED_CIDRS=127.0.0.1/32,::1/128

SPAMASSASSIN_MODE=local
SPAMHAUS_ENABLED=false
AI_ENABLED=false
```

## Important Environment Variables

### Core

| Variable | Purpose |
|---|---|
| `PORT` | HTTP listener port. Default is `3090`. |
| `MAILBRIDGE_HOSTNAME` | Public hostname for this Mailbridge instance. |
| `WEBHOOK_SECRET` | Shared secret required on inbound Worker webhook requests. |
| `DATA_DIR` | Runtime data directory. |
| `SECRETS_DB_PATH` | SQLite DB path for queue secret material. |
| `QUEUE_MASTER_KEY` | Base64 master key for encrypted local retry queue. |
| `MAILBRIDGE_PRIVATE_KEY_PATH` | Private key used to decrypt Worker-encrypted R2 payloads. |
| `AUDIT_LOG_RETENTION_DAYS` | Retention period for audit records. |

### Local mail delivery

| Variable | Purpose |
|---|---|
| `LOCAL_MAIL_HOST` | SMTP server that receives inbound mail from Mailbridge. |
| `LOCAL_MAIL_PORT` | SMTP port for local delivery, usually `25`. |
| `LOCAL_MAIL_SECURE` | Use implicit TLS for local delivery. |
| `LOCAL_MAIL_REQUIRE_TLS` | Require STARTTLS before local delivery. |
| `LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED` | Enforce TLS certificate validation. |
| `LOCAL_MAIL_TLS_SERVERNAME` | Optional SNI/servername override. Useful when `LOCAL_MAIL_HOST` is an IP. |
| `LOCAL_MAIL_TLS_CA_FILE` | Optional CA file for internal certificates. |

For production, prefer verified TLS:

```dotenv
LOCAL_MAIL_REQUIRE_TLS=true
LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED=true
```

For initial lab testing against an internal SMTP server, you may explicitly opt out:

```dotenv
LOCAL_MAIL_REQUIRE_TLS=false
LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED=false
```

### Outbound relay

| Variable | Purpose |
|---|---|
| `SMTP_RELAY_ENABLED` | Enables Mailbridge SMTP relay listener. |
| `SMTP_RELAY_PORT` | SMTP relay port, usually `2525`. |
| `SMTP_RELAY_REQUIRE_TLS` | Requires STARTTLS before accepting relay mail. |
| `SMTP_RELAY_ALLOWED_CIDRS` | Allowed client source networks. |
| `SMTP_RELAY_TLS_CERT_FILE` | TLS certificate for SMTP relay. |
| `SMTP_RELAY_TLS_KEY_FILE` | TLS private key for SMTP relay. |
| `SMTP_RELAY_TLS_CA_FILE` | Optional CA file. |
| `SMTP_RELAY_VERBOSE_LOGGING` | Enables verbose SMTP relay logs. |
| `SMTP_RELAY_INJECT_HEADERS` | Adds relay diagnostic headers. |

Example LAN-only relay:

```dotenv
SMTP_RELAY_ENABLED=true
SMTP_RELAY_PORT=2525
SMTP_RELAY_REQUIRE_TLS=false
SMTP_RELAY_ALLOWED_CIDRS=192.168.1.0/24,127.0.0.1/32
```

If you test from Docker Desktop on macOS, the container may see host connections from a Docker Desktop bridge address such as `192.168.65.1`. In that case, include the Docker Desktop subnet:

```dotenv
SMTP_RELAY_ALLOWED_CIDRS=192.168.1.0/24,192.168.65.0/24,127.0.0.1/32
```

Do not expose the SMTP relay to the public internet.

### Provider selection

| Variable | Purpose |
|---|---|
| `RELAY_UPSTREAM_PROVIDER` | `sendgrid`, `resend`, `mailgun`, or `cloudflare`. |
| `RELAY_API_KEY` | API key for SendGrid, Resend, or Mailgun. |
| `RELAY_FROM_FALLBACK` | Fallback sender address. |
| `RESEND_BASE_URL` | Resend API base URL. |
| `MAILGUN_DOMAIN` | Required for Mailgun. |
| `MAILGUN_BASE_URL` | Mailgun API base URL. |
| `CLOUDFLARE_SEND_WORKER_URL` | Worker `/api/send/email` endpoint for Cloudflare Email Service. |
| `CLOUDFLARE_SEND_WEBHOOK_SECRET` | Secret used to authenticate Mailbridge to the Worker send endpoint. |

Cloudflare outbound example:

```dotenv
RELAY_UPSTREAM_PROVIDER=cloudflare
CLOUDFLARE_SEND_WORKER_URL=https://mailbridge-worker.example.workers.dev/api/send/email
CLOUDFLARE_SEND_WEBHOOK_SECRET=replace_with_worker_send_secret
```

If using a custom Worker hostname, make sure it resolves from inside the container. If it does not, use the deployed `workers.dev` URL until DNS is fixed.

### Cloudflare Tunnel

Mailbridge can optionally start `cloudflared` from the container entrypoint.

```dotenv
CLOUDFLARED_ENABLED=true
CLOUDFLARED_TUNNEL_TOKEN=your_tunnel_token
CLOUDFLARED_LOGLEVEL=info
```

If you run `cloudflared` as a host service instead, keep this disabled:

```dotenv
CLOUDFLARED_ENABLED=false
CLOUDFLARED_TUNNEL_TOKEN=
```

Do not run both the host service and in-container tunnel for the same hostname unless you intentionally want multiple connectors.

### SpamAssassin

Local SpamAssassin mode:

```dotenv
SPAMASSASSIN_MODE=local
SPAMD_HOST=127.0.0.1
SPAMD_PORT=783
SPAMD_STARTUP_ATTEMPTS=30
SPAMC_TIMEOUT_MS=10000
SPAMC_FAIL_OPEN=false
SA_BLOCK_THRESHOLD=12
SA_QUESTIONABLE_THRESHOLD=5
SPAM_SCL_SCORE=9
SPAM_SUBJECT_TAG=[SPAM]
```

Postmark SpamCheck mode:

```dotenv
SPAMASSASSIN_MODE=postmark
POSTMARK_SPAMCHECK_URL=https://spamcheck.postmarkapp.com/filter
```

In local mode, the container starts `spamd` and Mailbridge sends a protocol `CHECK` request. Successful replies use `0 EX_OK` and include a `Spam: True|False ; score / threshold` header. Scores are parsed as signed real numbers, so legitimate negative ham scores are handled correctly.

In Postmark mode, Mailbridge sends the raw message to the SpamCheck API with `options=short` and uses the returned SpamAssassin score. The container skips starting local `spamd` in this mode.

### Spamhaus

Spamhaus checks are optional and disabled by default:

```dotenv
SPAMHAUS_ENABLED=false
SPAMHAUS_USERNAME=
SPAMHAUS_PASSWORD=
SPAMHAUS_FAIL_OPEN=true
```

When enabled, Mailbridge checks the original sender IP from the decrypted Worker payload, not the Cloudflare request IP.

### AI screening

AI scanning is optional and disabled by default:

```dotenv
AI_ENABLED=false
AI_API_KEY=
AI_MODEL=gpt-5.4-nano
AI_BASE_URL=
AI_INPUT_SCOPE=headers
AI_MAX_INPUT_CHARS=20000
```

Available input scopes:

- `headers`
- `attachments`
- `full_email`

`attachments` sends headers plus attachment filenames only. It does not send attachment contents.

When AI scanning runs, Mailbridge expects structured JSON:

```json
{
  "spam": 0,
  "reason": "not_spam",
  "score": 0
}
```

`score=9` means highly likely spam. `score=0` means not likely spam.

## Docker Startup

### Docker Compose

The default compose file mounts both `./data` and `./secrets` into the container and publishes the configured ports:

```bash
docker compose up -d --build
```

Runtime layout inside mounted volumes:

```text
data/mailbridge.db
data/queue/<queue-id>.eml
secrets/secrets.db
secrets/mailbridge-r2-private.pem
```

`data/queue/*.eml` files are encrypted at rest. They are created only for messages that enter the retry queue. Messages delivered immediately stay in memory and are not written to disk as queue files.

For production, store `secrets/` somewhere more protected than the app directory, ideally a separate encrypted disk, secret-backed mount, or protected host path.

Example hardened override:

```yaml
services:
  mail-bridge:
    volumes:
      - "./data:/app/data"
      - "/srv/mailbridge-secrets:/app/secrets"
```

If you need to expose the relay intentionally, use a local compose override:

```yaml
services:
  mail-bridge:
    ports:
      - "3090:3090"
      - "2525:2525"
```

If you use Cloudflare Tunnel, `3090` does not need to be publicly reachable. You can bind it to localhost only:

```yaml
services:
  mail-bridge:
    ports:
      - "127.0.0.1:3090:3090"
      - "2525:2525"
```

If your local mail server is reachable only through a fixed IP, add an `extra_hosts` entry in a local compose override instead of editing the default compose file:

```yaml
services:
  mail-bridge:
    extra_hosts:
      - "local-mail:10.1.1.2"
```

### Docker Run

```bash
docker run \
  --name mail-bridge \
  --restart unless-stopped \
  --env-file .env \
  -v "$PWD/data:/app/data" \
  -v "$PWD/secrets:/app/secrets" \
  -p 3090:3090 \
  ghcr.io/imrasalghul/mailbridge
```

If you need the SMTP relay:

```bash
docker run \
  --name mail-bridge \
  --restart unless-stopped \
  --env-file .env \
  -v "$PWD/data:/app/data" \
  -v "$PWD/secrets:/app/secrets" \
  -p 3090:3090 \
  -p 2525:2525 \
  ghcr.io/imrasalghul/mailbridge
```

## Run From Source

1. Copy `.env.example` to `.env`.
2. Set `DATA_DIR=./data`.
3. Set `SECRETS_DB_PATH=./secrets/secrets.db`.
4. Generate and set `QUEUE_MASTER_KEY`.
5. Generate the Mailbridge private/public key pair.
6. Create runtime directories:

```bash
mkdir -p data/queue secrets
```

7. Install and start:

```bash
npm install
npm start
```

Source mode uses the same runtime layout:

```text
data/mailbridge.db
data/queue/<queue-id>.eml
secrets/secrets.db
secrets/mailbridge-r2-private.pem
```

## Cloudflare Worker Setup

This project includes `worker.js`, which handles:

- Cloudflare Email Routing `email()` events
- R2 encrypted object storage
- Queue producer and consumer flow
- Webhook delivery to Mailbridge
- Optional Cloudflare Email Service outbound sending through `fetch()`

You can configure Cloudflare manually in the dashboard or with Wrangler.

## Wrangler Configuration

A safe public-repo `wrangler.toml` example:

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

The `[[send_email]]` block must be top-level. Do not put `send_email = [...]` inside a queue consumer block.

For a public repository, do not commit:

- account IDs
- tunnel tokens
- API tokens
- private keys
- live webhook secrets
- live Worker send secrets
- live `.env`

## Cloudflare Worker Secrets

Required secrets:

```text
WEBHOOK_SECRET
MAILBRIDGE_PUBLIC_KEY_PEM
```

Required only for Cloudflare outbound relay:

```text
CLOUDFLARE_SEND_WEBHOOK_SECRET
```

Set them with Wrangler:

```bash
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put MAILBRIDGE_PUBLIC_KEY_PEM
npx wrangler secret put CLOUDFLARE_SEND_WEBHOOK_SECRET
```

`MAILBRIDGE_PUBLIC_KEY_PEM` should be the full contents of:

```bash
cat secrets/mailbridge-r2-public.pem
```

Include:

```text
-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----
```

## Cloudflare Resources

### R2 bucket

Create a private R2 bucket, for example:

```text
mailbridge-inbound
```

Worker binding:

```text
MAIL_STORE
```

The Worker stores encrypted ciphertext in this bucket, not plaintext raw mail.

### Queue

Create a queue, for example:

```text
mailbridge-inbound
```

Worker producer binding:

```text
MAIL_QUEUE
```

Attach the same Worker as the consumer.

Recommended starting consumer settings:

```text
max_batch_size = 10
max_batch_timeout = 5
max_retries = 3
dead-letter queue = optional
```

### Email Service binding

If using Cloudflare Email Service for outbound relay, add a send email binding named:

```text
EMAIL
```

Wrangler syntax:

```toml
[[send_email]]
name = "EMAIL"
```

Mailbridge sends outbound requests to:

```text
CLOUDFLARE_SEND_WORKER_URL
```

The Worker verifies the send secret and sends through:

```js
env.EMAIL.send(...)
```

## Cloudflare Dashboard Setup

### 1. Create the Worker

1. Open Cloudflare Workers & Pages.
2. Create a Worker.
3. Replace the default code with `worker.js`.
4. Deploy once so bindings and secrets can be attached.

### 2. Add R2 binding

Binding name:

```text
MAIL_STORE
```

Bucket example:

```text
mailbridge-inbound
```

### 3. Add Queue binding

Producer binding name:

```text
MAIL_QUEUE
```

Queue example:

```text
mailbridge-inbound
```

Attach the same Worker as the queue consumer.

### 4. Add variables

```text
NODE_APP_URL=https://mailbridge.example.com/api/webhook/email
MAIL_STORE_ENCRYPTION_VERSION=v1
```

If `NODE_APP_URL` is only an origin, the Worker may append `/api/webhook/email` depending on implementation.

### 5. Add secrets

```text
WEBHOOK_SECRET
MAILBRIDGE_PUBLIC_KEY_PEM
CLOUDFLARE_SEND_WEBHOOK_SECRET
```

### 6. Set up Email Routing

1. Open Cloudflare Email Routing.
2. Create or edit a route for the desired address.
3. Choose the Worker as the destination.

This sends inbound mail into the Worker `email()` handler, which encrypts the message, stores it in R2, and enqueues an object reference for Mailbridge delivery.

### 7. Set up Tunnel

If the container runs `cloudflared`:

1. Open Cloudflare Zero Trust / Tunnels.
2. Create a tunnel.
3. Add a public hostname for Mailbridge.
4. Point it to:

```text
http://localhost:3090
```

5. Copy the tunnel token.
6. Set:

```dotenv
CLOUDFLARED_ENABLED=true
CLOUDFLARED_TUNNEL_TOKEN=your_tunnel_token
CLOUDFLARED_LOGLEVEL=info
```

7. Restart the container.

If running `cloudflared` as a host service instead, keep the Mailbridge container tunnel disabled.

## Testing

### Test local webhook

```bash
curl -i http://127.0.0.1:3090/api/webhook/email
```

A `401`, `403`, `405`, or validation response is acceptable. Connection refused means Mailbridge is not listening.

### Test public webhook through tunnel

```bash
curl -i https://mailbridge.example.com/api/webhook/email
```

A webhook auth or validation response is acceptable. Cloudflare `502`, `1033`, or tunnel errors indicate a tunnel/hostname/origin problem.

### Test local mail server reachability

```bash
nc -vz mail.internal.example 25
```

Or, from inside the container:

```bash
docker exec -it mail-bridge sh -lc 'node -e "
const net=require(\"net\");
const s=net.createConnection(process.env.LOCAL_MAIL_PORT, process.env.LOCAL_MAIL_HOST);
s.on(\"connect\",()=>{ console.log(\"SMTP reachable\"); process.exit(0); });
s.on(\"error\",e=>{ console.error(e); process.exit(1); });
"'
```

### Test inbound mail

Send an email to an address routed to the Worker.

Watch logs:

```bash
docker logs -f mail-bridge
```

Successful inbound delivery looks like:

```text
[Webhook] Inbound payload accepted ...
[SpamAssassin] Score resolved ...
[Webhook] Injected inbound local-mail headers ...
Direct delivery successful.
```

### Test outbound SMTP relay

Install `swaks` if needed:

```bash
brew install swaks
```

Test relay:

```bash
swaks \
  --server 127.0.0.1 \
  --port 2525 \
  --from postmaster@example.com \
  --to recipient@example.net \
  --header "Subject: Mailbridge outbound test" \
  --body "This is an outbound relay test through Mailbridge."
```

Successful relay acceptance looks like:

```text
MAIL FROM accepted
RCPT accepted
Received message from local relay client
```

If the upstream provider is unavailable, Mailbridge queues the message for retry.

## Troubleshooting

### `Connection refused` on port 2525

The SMTP relay may be listening inside the container but not published to the host.

Check:

```bash
docker compose ps
```

You should see:

```text
0.0.0.0:2525->2525/tcp
```

If not, add a local compose override:

```yaml
services:
  mail-bridge:
    ports:
      - "3090:3090"
      - "2525:2525"
```

Restart:

```bash
docker compose up -d
```

### `SMTP relay connection from ... is not allowed`

Add the client network to:

```dotenv
SMTP_RELAY_ALLOWED_CIDRS=
```

For Docker Desktop on macOS, the client may appear as `192.168.65.1`. Add:

```dotenv
SMTP_RELAY_ALLOWED_CIDRS=192.168.65.0/24,127.0.0.1/32
```

Include your LAN CIDR if needed:

```dotenv
SMTP_RELAY_ALLOWED_CIDRS=192.168.1.0/24,192.168.65.0/24,127.0.0.1/32
```

### `getaddrinfo ENOTFOUND postmaster.example.com`

The container cannot resolve the Worker hostname configured in:

```dotenv
CLOUDFLARE_SEND_WORKER_URL=
```

Use the deployed `workers.dev` URL temporarily:

```dotenv
CLOUDFLARE_SEND_WORKER_URL=https://your-worker.your-account.workers.dev/api/send/email
```

Then switch back to the custom hostname once DNS is correct.

### Wrangler deploy warning: unexpected `send_email`

Bad syntax:

```toml
[[queues.consumers]]
queue = "mailbridge-inbound"

send_email = [
  { name = "EMAIL" }
]
```

Correct syntax:

```toml
[[queues.consumers]]
queue = "mailbridge-inbound"

[[send_email]]
name = "EMAIL"
```

After deploy, Wrangler output should show `env.EMAIL`.

### SpamAssassin DNSBL warnings

You may see warnings such as:

```text
RCVD_IN_DNSWL_BLOCKED
URIBL_BLOCKED
RCVD_IN_ZEN_BLOCKED_OPENDNS
```

These usually mean DNSBL providers are rate-limiting or blocking lookups from your resolver. Mailbridge can still parse the SpamAssassin score.

Options:

- use a better resolver
- disable affected SpamAssassin DNSBL rules
- use Postmark SpamCheck mode
- enable/disable Spamhaus explicitly based on your deployment

### Spamhaus enabled but credentials missing

If logs show:

```text
Spamhaus is enabled but SPAMHAUS_USERNAME/SPAMHAUS_PASSWORD are not configured
```

Either provide credentials:

```dotenv
SPAMHAUS_ENABLED=true
SPAMHAUS_USERNAME=...
SPAMHAUS_PASSWORD=...
```

or disable it:

```dotenv
SPAMHAUS_ENABLED=false
```

### TLS ServerName warning with IP local mail host

If `LOCAL_MAIL_HOST` is an IP and TLS is used, Node may warn that TLS ServerName cannot be an IP.

Set:

```dotenv
LOCAL_MAIL_TLS_SERVERNAME=mail.internal.example
```

or disable local TLS only for lab testing:

```dotenv
LOCAL_MAIL_REQUIRE_TLS=false
LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED=false
```

## Security Notes

- Never commit `.env`.
- Never commit private keys.
- Never commit tunnel tokens.
- Never commit Worker secrets.
- Keep `secrets/` separate from `data/` where possible.
- Keep `SMTP_RELAY_ENABLED=false` unless you actually need outbound relay.
- Do not expose the SMTP relay publicly.
- Prefer TLS and narrow CIDR allowlists for the relay.
- Prefer verified TLS for local mail delivery.
- Leave AI scanning disabled unless your compliance posture allows it.

Recommended `.gitignore` entries:

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

## Security and Reliability

- All inbound webhook requests require the shared `X-Webhook-Secret` header.
- R2-stored inbound mail is encrypted before storage.
- Only Mailbridge has the private key required to decrypt inbound R2 payloads.
- Temporary local-mail and upstream-provider failures are queued and retried.
- Queued messages are encrypted at rest.
- Active queue secrets live in `secrets/secrets.db`.
- Audit data lives in `data/mailbridge.db`.
- Permanent SMTP/API failures are rejected instead of retried forever.

## License

Copyright © 2026 Ra's al Ghul
