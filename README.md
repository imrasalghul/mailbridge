# Mailbridge

Mailbridge bridges Cloudflare Email Workers to an internal mail server for inbound mail, and bridges trusted LAN SMTP traffic to SendGrid for outbound mail.

## Overview

- Inbound flow: Sender -> Cloudflare Email Worker -> Cloudflare R2 -> Cloudflare Queue -> Mailbridge webhook -> Exchange SMTP
- Outbound flow: Exchange or trusted LAN -> Mailbridge SMTP relay -> SendGrid API

## Key Features

- Multi-layer inbound filtering with SpamAssassin, optional AI review, and optional AbuseIPDB sender-IP checks
- HTTP webhook intake for Cloudflare Email Workers and SMTP intake for Exchange or trusted LAN systems
- SQLite-backed retry queue for temporary Exchange and SendGrid failures
- Exchange-friendly spam headers and subject tagging for inbound mail
- Optional in-container `cloudflared` tunnel for publishing the webhook without directly exposing port `3090`

## Local Configuration

Copy `.env.example` to `.env` and update the values for your environment.

```bash
cp .env.example .env
```

Minimum settings to review before first start:

```dotenv
MAILBRIDGE_HOSTNAME=mailbridge.example.com
WEBHOOK_SECRET=replace_with_a_shared_secret

EXCHANGE_HOST=mail.internal.example
EXCHANGE_PORT=25

SENDGRID_API_KEY=SG.your_api_key
SENDGRID_FROM_FALLBACK=relay@example.com

# Optional AI screening
AI_API_KEY=

# Optional in-container tunnel
CLOUDFLARED_ENABLED=false
CLOUDFLARED_TUNNEL_TOKEN=
CLOUDFLARED_LOGLEVEL=info
```

Notes:

- `WEBHOOK_SECRET` must match the `WEBHOOK_SECRET` secret configured on the Cloudflare Worker.
- If `CLOUDFLARED_ENABLED=true`, the container starts `cloudflared` and requires `CLOUDFLARED_TUNNEL_TOKEN`.
- `SMTP_RELAY_PORT` should only be reachable from trusted Exchange or LAN sources.

## Docker Startup

Build and start the container:

```bash
docker compose up -d --build
```

Default exposed ports:

- `3090/tcp` for webhook intake
- `2525/tcp` for SMTP relay

If you are using the built-in Cloudflare Tunnel, `3090` does not need to be publicly reachable. You can remove the `3090:3090` port mapping or bind it to localhost only in your own compose override.

If your Exchange host is only reachable through a fixed IP and not normal DNS, add an `extra_hosts` entry in your local compose override instead of editing the default compose file:

```yaml
services:
  mail-bridge:
    extra_hosts:
      - "exchange-server:10.1.1.2"
```

## Cloudflare Dashboard Setup

This project includes a ready-to-paste Worker script in [`worker.js`](./worker.js). The Cloudflare side should be created in the dashboard with that file as the Worker code.

### 1. Create the Worker

1. In Cloudflare, open Workers & Pages.
2. Create a new Worker.
3. Replace the default code with the contents of [`worker.js`](./worker.js).
4. Deploy the Worker once so bindings and secrets can be attached.

### 2. Create the R2 bucket

1. Open R2 in the Cloudflare dashboard.
2. Create a private bucket for raw inbound mail, for example `mailbridge-inbound`.
3. Go back to the Worker and add an R2 binding:
   - Binding name: `MAIL_STORE`
   - Bucket: the bucket you just created

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
- Variable: `NODE_APP_URL`
  - Value: the public webhook URL, including the path
  - Example: `https://mailbridge.example.com/api/webhook/email`

The Worker already expects these Cloudflare bindings and variables:

- `MAIL_STORE` for R2
- `MAIL_QUEUE` for Cloudflare Queues
- `WEBHOOK_SECRET` for webhook authentication
- `NODE_APP_URL` for the public Mailbridge webhook endpoint

### 5. Set up Email Routing

1. Open Email Routing in the Cloudflare dashboard.
2. Create or edit the route for the address you want Cloudflare to send into Mailbridge.
3. Choose the Worker you created above as the destination for that route.

This sends inbound mail into the Worker `email()` handler, which stores the raw message in R2 and enqueues it for delivery to Mailbridge.

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

Mailbridge will start `cloudflared tunnel --no-autoupdate run --token ...` from the main entrypoint when enabled.

## Exchange Send Connector

Configure Exchange to route outbound Internet mail through Mailbridge by pointing the send connector smart host to the Mailbridge host and port `2525` or your custom `SMTP_RELAY_PORT`.

Mailbridge accepts SMTP from trusted LAN systems and relays it through SendGrid. Temporary SendGrid failures are queued locally and retried automatically.

## Security and Reliability

- All inbound webhook requests require the shared `X-Webhook-Secret` header.
- Restrict access to the SMTP relay port to trusted Exchange or LAN hosts only.
- If you use the Cloudflare Tunnel, the webhook port does not need to be publicly exposed.
- Temporary Exchange or SendGrid failures are queued and retried.
- Permanent SMTP or API failures are rejected instead of retried forever.

Copyright © 2026 Ra's al Ghul
