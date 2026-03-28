# Mailbridge

Mailbridge bridges Cloudflare Email Workers to a local mail server for inbound mail, and can relay trusted SMTP traffic to SendGrid, Resend, or Mailgun for outbound mail.

## Overview

- Inbound flow: Sender -> Cloudflare Email Worker -> encrypted R2 object -> Cloudflare Queue -> Mailbridge webhook -> local mail server
- Outbound flow: trusted SMTP client -> Mailbridge SMTP relay -> selected upstream provider API

## Key Features

- Multi-layer inbound filtering with SpamAssassin and optional AI review
- Optional Spamhaus sender-IP and sender-domain reputation checks
- HTTP webhook intake for Cloudflare Email Workers
- Optional SMTP relay for local systems that need to hand outbound mail to SendGrid, Resend, or Mailgun
- Encrypted file-backed retry queue for temporary local-mail and upstream provider failures
- Audit-only SQLite storage at `data/mailbridge.db`
- Separate queue-secrets storage at `secrets/secrets.db`
- Public-key encryption for mail stored in R2 so only Mailbridge can decrypt it
- Exchange-friendly spam headers and subject tagging for inbound mail
- Optional in-container `cloudflared` tunnel for publishing the webhook without directly exposing port `3090`

## Quick Start

Pull the published container:

```bash
docker pull ghcr.io/imrasalghul/mailbridge
```

Create your local config and runtime directories:

```bash
cp .env.example .env
mkdir -p data/queue secrets
```

Generate the local queue master key and place it in `.env`:

```bash
openssl rand -base64 32 | tr -d '\n'
```

Generate the Mailbridge private key used to decrypt R2-backed inbound mail:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out secrets/mailbridge-r2-private.pem
openssl rsa -pubout -in secrets/mailbridge-r2-private.pem -out secrets/mailbridge-r2-public.pem
```

Set the base64 key as `QUEUE_MASTER_KEY=` in `.env`, keep the private key at the path configured by `MAILBRIDGE_PRIVATE_KEY_PATH`, and copy the public key contents into the Cloudflare Worker secret `MAILBRIDGE_PUBLIC_KEY_PEM`.

## Local Configuration

Review these settings before first start:

```dotenv
MAILBRIDGE_HOSTNAME=mailbridge.example.com
WEBHOOK_SECRET=replace_with_a_shared_secret

LOCAL_MAIL_HOST=mail.internal.example
LOCAL_MAIL_PORT=25

RELAY_UPSTREAM_PROVIDER=sendgrid
RELAY_API_KEY=replace_with_provider_api_key
RELAY_FROM_FALLBACK=relay@example.com
MAILGUN_DOMAIN=mg.example.com

DATA_DIR=/app/data
SECRETS_DB_PATH=/app/secrets/secrets.db
QUEUE_MASTER_KEY=replace_with_a_base64_32_byte_value
MAILBRIDGE_PRIVATE_KEY_PATH=/app/secrets/mailbridge-r2-private.pem
AUDIT_LOG_RETENTION_DAYS=1
```

Important notes:

- `WEBHOOK_SECRET` must match the `WEBHOOK_SECRET` secret configured on the Cloudflare Worker.
- `QUEUE_MASTER_KEY` is mandatory. Mailbridge uses it together with a random per-message secret stored in `secrets.db` to decrypt locally queued mail.
- `MAILBRIDGE_PRIVATE_KEY_PATH` points to the private key Mailbridge uses to decrypt inbound mail that the Worker encrypted before storing in R2.
- `RELAY_UPSTREAM_PROVIDER` accepts `sendgrid`, `resend`, or `mailgun`.
- `RELAY_API_KEY` is the outbound API credential used for the selected provider.
- `MAILGUN_DOMAIN` is required only when `RELAY_UPSTREAM_PROVIDER=mailgun`. If you use Mailgun EU, set `MAILGUN_BASE_URL=https://api.eu.mailgun.net`.
- `SPAMHAUS_ENABLED=false` and `AI_ENABLED=false` in `.env.example` are intentional. Both controls are optional and must be enabled deliberately.
- SMTP relay TLS is fail-closed by default. If you want to use the relay, set `SMTP_RELAY_TLS_CERT_FILE` and `SMTP_RELAY_TLS_KEY_FILE` before exposing or using port `2525`.
- Local mail delivery is TLS-first by default. If your local mail server does not support a verifiable TLS path yet, you must explicitly opt out with `LOCAL_MAIL_REQUIRE_TLS=false` and, if needed, `LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED=false`.
- If `CLOUDFLARED_ENABLED=true`, the container starts `cloudflared` and requires `CLOUDFLARED_TUNNEL_TOKEN`.

## Docker Startup

### Docker Compose

The default compose file mounts both `./data` and `./secrets` into the container and publishes only the webhook port:

```bash
docker compose up -d --build
```

Runtime layout inside the mounted volumes:

- `data/mailbridge.db`
- `data/queue/<queue-id>.eml`
- `secrets/secrets.db`
- `secrets/mailbridge-r2-private.pem`

`data/queue/*.eml` files are encrypted at rest. They are created only for messages that enter the retry queue. Messages delivered immediately stay in memory and are not written to disk as queue files.

The default compose file uses `./secrets:/app/secrets` for convenience. For production, change the host side to a different location than `./data`, ideally a separate encrypted disk, secret-backed mount, or another protected path.

Example hardened override:

```yaml
services:
  mail-bridge:
    volumes:
      - "./data:/app/data"
      - "/srv/mailbridge-secrets:/app/secrets"
```

The default compose file does not publish `2525/tcp`. This is intentional: the SMTP relay should only be exposed after you have configured TLS and narrowed the allowed CIDRs.

If you need to expose the relay intentionally, use a local compose override:

```yaml
services:
  mail-bridge:
    ports:
      - "3090:3090"
      - "2525:2525"
```

If you are using the built-in Cloudflare Tunnel, `3090` does not need to be publicly reachable. You can remove the `3090:3090` port mapping or bind it to localhost only in your own compose override.

If your local mail server is only reachable through a fixed IP and not normal DNS, add an `extra_hosts` entry in your local compose override instead of editing the default compose file:

```yaml
services:
  mail-bridge:
    extra_hosts:
      - "local-mail:10.1.1.2"
```

### Docker Run

If you prefer to run the published image directly:

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

For production, replace `$PWD/secrets` with a different host path than `$PWD/data`.

## Run From Source

If you run Mailbridge from source instead of the container:

1. Copy `.env.example` to `.env`.
2. Set `DATA_DIR=./data` in `.env`.
3. Set `SECRETS_DB_PATH=./secrets/secrets.db` in `.env`.
4. Generate and set `QUEUE_MASTER_KEY`.
5. Generate the Mailbridge private key and place it under `./secrets`.
6. Create the runtime directories:

```bash
mkdir -p data/queue secrets
```

7. Install and start:

```bash
npm install
npm start
```

Source mode uses the same runtime layout:

- `data/mailbridge.db`
- `data/queue/<queue-id>.eml`
- `secrets/secrets.db`
- `secrets/mailbridge-r2-private.pem`

## Cloudflare Dashboard Setup

This project includes a ready-to-paste Worker script in [`worker.js`](./worker.js). The Cloudflare side should be created in the dashboard with that file as the Worker code.

### 1. Create the Worker

1. In Cloudflare, open Workers & Pages.
2. Create a new Worker.
3. Replace the default code with the contents of [`worker.js`](./worker.js).
4. Deploy the Worker once so bindings and secrets can be attached.

### 2. Create the R2 bucket

1. Open R2 in the Cloudflare dashboard.
2. Create a private bucket for inbound mail, for example `mailbridge-inbound`.
3. Go back to the Worker and add an R2 binding:
   - Binding name: `MAIL_STORE`
   - Bucket: the bucket you just created

The Worker now stores ciphertext in this bucket, not plaintext raw mail.

### 3. Create the Queue

1. Open Queues in the Cloudflare dashboard.
2. Create a queue for inbound delivery, for example `mailbridge-inbound`.
3. In the Worker settings, add a queue producer binding:
   - Binding name: `MAIL_QUEUE`
   - Queue: the queue you just created
4. Attach the same Worker as the queue consumer for that queue.
5. Use the default consumer settings for this release:
   - `max_batch_size=10`
   - `max_batch_timeout=5`
   - `max_retries=3`
   - no dead-letter queue

### 4. Add Worker variables and secrets

In Worker Settings -> Variables and Secrets, add:

- Secret: `WEBHOOK_SECRET`
  - Value: exactly the same value you put in Mailbridge `.env`
- Secret: `MAILBRIDGE_PUBLIC_KEY_PEM`
  - Value: the full contents of `secrets/mailbridge-r2-public.pem`
- Variable: `NODE_APP_URL`
  - Value: the public webhook URL, including the path
  - Example: `https://mailbridge.example.com/api/webhook/email`
- Variable: `MAIL_STORE_ENCRYPTION_VERSION`
  - Value: `v1`

The Worker expects these bindings and variables:

- `MAIL_STORE` for R2
- `MAIL_QUEUE` for Cloudflare Queues
- `WEBHOOK_SECRET` for webhook authentication
- `MAILBRIDGE_PUBLIC_KEY_PEM` for encrypting mail before R2 storage
- `MAIL_STORE_ENCRYPTION_VERSION` for payload format versioning
- `NODE_APP_URL` for the public Mailbridge webhook endpoint

### 5. Set up Email Routing

1. Open Email Routing in the Cloudflare dashboard.
2. Create or edit the route for the address you want Cloudflare to send into Mailbridge.
3. Choose the Worker you created above as the destination for that route.

This sends inbound mail into the Worker `email()` handler, which encrypts the message, stores it in R2, and enqueues an opaque object reference for delivery to Mailbridge.

### 6. Set up the Tunnel

If you want this container to run `cloudflared` itself:

1. In Cloudflare, open Networking -> Tunnels.
2. Create a tunnel.
3. Add a public hostname for Mailbridge.
4. Point that hostname to `http://localhost:3090`.
5. Copy the tunnel token from the dashboard.
6. Set these values in `.env`:

```dotenv
CLOUDFLARED_ENABLED=true
CLOUDFLARED_TUNNEL_TOKEN=your_tunnel_token
CLOUDFLARED_LOGLEVEL=info
```

7. Restart the container.

Mailbridge starts `cloudflared tunnel --no-autoupdate run --token ...` from the main entrypoint when enabled.

## Local Mail Server Example

If you are using Exchange, point the inbound destination at your Exchange host with `LOCAL_MAIL_HOST` and `LOCAL_MAIL_PORT`.

If you plan to send outbound mail through Mailbridge from Exchange or another local system, point that system at the Mailbridge host on `SMTP_RELAY_PORT` after you have configured relay TLS and CIDR allowlisting.

## Hardening

### Local Mail TLS

Mailbridge uses a verified TLS path to the local mail server by default:

- `LOCAL_MAIL_REQUIRE_TLS=true` requires STARTTLS on non-implicit TLS connections
- `LOCAL_MAIL_TLS_REJECT_UNAUTHORIZED=true` enforces certificate verification
- `LOCAL_MAIL_TLS_CA_FILE` lets you trust an internal CA instead of disabling verification

This is the recommended production posture. If your local mail server still uses plaintext or an untrusted certificate, you must opt out explicitly instead of Mailbridge silently falling back.

### SMTP Relay TLS and Network Restrictions

The SMTP relay is designed to be locked down before use:

- `SMTP_RELAY_REQUIRE_TLS=true` requires STARTTLS before mail submission
- `SMTP_RELAY_ALLOWED_CIDRS` limits which source networks may connect
- `SMTP_RELAY_TLS_CERT_FILE` and `SMTP_RELAY_TLS_KEY_FILE` must be set before secure relay use
- the default compose file does not publish `2525`

This means the relay is not meant to be a general plaintext LAN service anymore. If you need a temporary lab-only exception, use explicit opt-out settings instead of relying on old defaults.

### Upstream Provider Selection

Outbound relay delivery is provider-selectable:

```dotenv
RELAY_UPSTREAM_PROVIDER=sendgrid
RELAY_API_KEY=...
RELAY_FROM_FALLBACK=relay@example.com
```

Supported values:

- `sendgrid`
- `resend`
- `mailgun`

Provider notes:

- `sendgrid`: uses the SendGrid Mail Send API
- `resend`: uses the Resend send email API
- `mailgun`: uses the Mailgun MIME send API and also requires `MAILGUN_DOMAIN`

### Queued Message Encryption and Secret Separation

Queued mail is encrypted at rest:

- only messages that enter the retry queue are written into `data/queue/*.eml`
- each queued file is encrypted with a key derived from `QUEUE_MASTER_KEY` plus a random per-message secret stored in `secrets.db`
- leaking only the queue file or only `secrets.db` is not enough to decrypt queued mail

`data/mailbridge.db` is audit-only. Active queue secrets live in `secrets/secrets.db`.

For stronger separation, store `data/` and `secrets/` on different host paths. In production, prefer putting `secrets/` on a different encrypted disk or secret-backed mount.

### Encrypted R2 Storage

Inbound mail stored in R2 is encrypted before it is written:

- the Worker only has the Mailbridge public key
- the Worker stores ciphertext in R2 and forwards ciphertext to Mailbridge
- only Mailbridge has the private key and can decrypt the message before spam checks, AI checks, and local delivery

This means Cloudflare stores encrypted mail objects instead of plaintext raw messages. During rollout, legacy plaintext R2 objects can still be processed until the old backlog drains.

### Optional Spamhaus Reputation Checks

Spamhaus integration is optional and disabled by default:

```dotenv
SPAMHAUS_ENABLED=false
```

When enabled, Mailbridge checks the original sender IP provided by the Worker payload after decryption, not the Cloudflare request IP that delivered the webhook. It also derives a normalized sender domain and checks that against Spamhaus domain listings.

Mailbridge caches the temporary Spamhaus bearer token and the Spamhaus TLD list in memory. It does not log in for every message.

### Optional AI Scanning

AI scanning is optional and disabled by default:

```dotenv
AI_ENABLED=false
```

When enabled without `AI_BASE_URL`, Mailbridge uses OpenAI by default through the official OpenAI SDK. If you set `AI_BASE_URL`, the same SDK can target a LiteLLM proxy or another OpenAI-compatible local endpoint instead.

Example direct OpenAI configuration:

```dotenv
AI_ENABLED=true
AI_API_KEY=sk-...
AI_MODEL=gpt-5.4-nano
AI_INPUT_SCOPE=headers
```

Example LiteLLM or local OpenAI-compatible endpoint:

```dotenv
AI_ENABLED=true
AI_API_KEY=proxy-or-local-token-if-needed
AI_BASE_URL=http://litellm.internal:4000/v1
AI_MODEL=gpt-5.4-nano
AI_INPUT_SCOPE=attachments
```

Available AI input scopes:

- `headers`: sends only the email headers to the model
- `attachments`: sends the headers plus attachment filenames only
- `full_email`: sends headers and body

`AI_INPUT_SCOPE=attachments` does not read or send attachment contents to AI. It only derives attachment names locally from MIME metadata and sends those names alongside the headers. This is useful when suspicious filename patterns are part of the signal, such as receiving `Invoice.pdf` from an obviously untrusted sender domain.

For OpenAI-backed deployments, review OpenAI’s business data controls and enable Zero Data Retention or stricter controls where your compliance posture requires it. For PCI/HIPAA-style environments, leave AI scanning disabled unless your legal, compliance, and vendor-review process has approved the provider path.

## Security and Reliability

- All inbound webhook requests require the shared `X-Webhook-Secret` header.
- Inbound sender reputation uses the original sender IP from the decrypted Worker payload, not the Worker request IP.
- Temporary local-mail or upstream provider failures are queued and retried.
- Queued messages are encrypted at rest and are written only when delivery must be deferred.
- R2-stored inbound mail is encrypted before storage and only Mailbridge can decrypt it.
- Permanent SMTP or API failures are rejected instead of retried forever.

Copyright © 2026 Ra's al Ghul
