# Mailbridge

Mailbridge is a security-focused Node.js mail gateway that connects Cloudflare Email Routing to a private SMTP server. It can also relay trusted outbound SMTP traffic through SendGrid, Resend, Mailgun, or Cloudflare Email Service.

For complete installation, architecture, configuration, security, operations, and troubleshooting documentation, use the **[Mailbridge Wiki](https://github.com/imrasalghul/mailbridge/wiki)**.

## Architecture

```text
Inbound:
Cloudflare Email Routing
-> Worker encryption
-> ciphertext-only R2 storage
-> Cloudflare Queue object reference
-> authenticated Mailbridge webhook
-> local decryption and spam screening
-> private SMTP server

Outbound:
trusted CIDR-restricted SMTP client
-> Mailbridge relay
-> SendGrid / Resend / Mailgun / Cloudflare Email Service
```

## Highlights

- Public-key envelope encryption before inbound mail reaches R2
- Authenticated Worker-to-Mailbridge webhook delivery
- SpamAssassin with local `spamd` or Postmark SpamCheck mode
- Optional Spamhaus and AI secondary screening
- Exchange-friendly spam headers and optional subject tagging
- Verified TLS support for private SMTP delivery
- Optional STARTTLS and CIDR-restricted outbound SMTP relay
- Configurable SMTP DATA size limit
- Four outbound provider integrations
- Encrypted local retry queue with separate secret storage
- Audit-only SQLite event database
- Optional in-container Cloudflare Tunnel
- Interactive configuration generator
- Explicit, exact-version plugin system for scanners and outbound providers

## Quick Start

Requirements:

- Node.js 22.23.3 or newer (packaged runtime: 22.23.3)
- Docker with Docker Compose
- Cloudflare Email Routing, Workers, R2, and Queues
- A private SMTP server

Clone the repository, install dependencies, and start the interactive setup:

```bash
npm install
npm run setup
```

The assistant creates `.env`, `wrangler.toml`, runtime directories, independent webhook secrets, the local queue master key, and the RSA keypair used for encrypted R2 handoff. It asks before overwriting existing configuration. Reruns retain existing secrets, keypairs, provider selection, and plugin settings. Restore a missing queue master key from backup before running setup when queued mail exists; generating a replacement cannot decrypt that mail. Secret values are not printed in setup's deployment instructions.

Cloudflare Email Service is built in. Other providers and optional scanners require separately published plugins. Supply an existing, trusted package with an exact version; setup does not assume named example packages are available on npm. Unversioned packages, `latest`, and version ranges are rejected. Plugins run in supervised child processes and receive only their declared namespaced settings and secrets.

Mailbridge discovers plugins from `MAILBRIDGE_PLUGIN_DIR` using `mailbridge-plugin.json`. A plugin declares one of three types:

- `provider`: receives `deliver` with the SMTP envelope and base64 RFC822 message.
- `scanner`: receives `scan`; capabilities such as `reputation` and `classification` determine when it runs.
- `middleware`: receives `transform` and may return a modified RFC822 message/envelope or reject delivery. This supports header editing, attachment removal, text inspection, redaction, and similar processing.

Middleware runs deterministically by manifest `priority`, then plugin ID. Plugins communicate over JSON Lines API version 1 and may also handle `init`, `health`, and `shutdown`. Configuration is namespaced in `MAILBRIDGE_PLUGIN_CONFIG_FILE`; secrets use `MAILBRIDGE_PLUGIN_<PLUGIN_ID>_<SECRET_NAME>`. Protected Mailbridge encryption and webhook secrets cannot be requested by a plugin. The setup assistant accepts exact-version community packages and prompts from manifest configuration/secret schemas.

See [Plugin Development](docs/PLUGIN_DEVELOPMENT.md) for the complete manifest, protocol, and middleware contracts.

Then run the Cloudflare commands printed by the assistant and start Mailbridge:

```bash
docker compose up -d --build
docker compose ps
docker logs -f mail-bridge
```

Check the health endpoint:

```bash
curl http://127.0.0.1:3090/health
```

Expected response: `OK`.

See the wiki [Quick Start](https://github.com/imrasalghul/mailbridge/wiki/Quick-Start) for resource creation, Worker secrets, deployment, and validation.

## Debian, Ubuntu, and Proxmox Mail Gateway

The amd64 package and APT repository support Debian 13 (Trixie) only. Install Mailbridge in a dedicated Debian 13 LXC or VM instead of directly on the Proxmox VE virtualization host.

Install the repository signing key and select the current distribution codename:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.alghul.com/gpg.key \
  | sudo gpg --dearmor --yes -o /etc/apt/keyrings/mailbridge-archive-keyring.gpg

. /etc/os-release
case "$VERSION_CODENAME" in
  trixie) ;;
  *) echo "Unsupported distribution: $VERSION_CODENAME" >&2; exit 1 ;;
esac

echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/mailbridge-archive-keyring.gpg] https://deb.alghul.com $VERSION_CODENAME main" \
  | sudo tee /etc/apt/sources.list.d/mailbridge.list
sudo apt-get update
sudo apt-get install mailbridge
```

Run the interactive configuration assistant, review the generated settings, and start the service:

```bash
sudo mailbridge-setup
sudoedit /etc/mailbridge/mailbridge.env
sudo systemctl enable --now mailbridge
sudo systemctl status mailbridge
```

The assistant creates the long runtime configuration, local encryption keys, queue secret, and Cloudflare Worker configuration. Follow its printed Wrangler commands to upload Worker secrets and deploy the Worker; never upload the generated private key.

## Security Defaults

- Inbound R2 objects contain ciphertext, never plaintext mail.
- The R2 decryption private key remains on the Mailbridge host.
- Local retry files are encrypted at rest.
- The SMTP relay is disabled and loopback-restricted by default.
- Relay STARTTLS and private SMTP certificate verification are preferred.
- Spam filtering fails closed unless explicitly configured otherwise.
- Spamhaus and AI screening are disabled by default.
- Generated secret-bearing configuration files use mode `0600`.

Never commit `.env`, live `wrangler.toml`, private keys, provider credentials, tunnel tokens, `data/`, or `secrets/`.

Read the complete [Security Model](https://github.com/imrasalghul/mailbridge/wiki/Security-Model) and repository [Security Policy](SECURITY.md).

## Delivery retries and recovery

The Worker supplies a stable delivery identity for each R2 object. Mailbridge stores completed outcomes in `DATA_DIR/delivery-receipts.db`; repeated or concurrent handoffs reuse those outcomes. This prevents another SMTP delivery when the original HTTP response or R2 cleanup fails. Back up this database along with the queue and its keys, and retain it while an R2 object or queue reference might still be replayed. Receipts contain identifiers, hashes, and generic outcomes, not raw mail. SMTP itself cannot guarantee exactly-once delivery if the process crashes after the remote server accepts mail but before the receipt is saved, or if the SMTP acknowledgement is lost.

SMTP 4xx failures enter the encrypted local retry queue; SMTP 5xx rejections return HTTP 422. The Worker deletes rejected mail only for explicit HTTP 400, 406, 413, or 422 responses. Authentication, configuration, timeout, throttling, and server failures retry without deleting R2 ciphertext.

Create `mailbridge-inbound-dead-letter` before deploying the updated Worker configuration. Setup creates it automatically when deployment is selected. Existing installations should add `dead_letter_queue = "mailbridge-inbound-dead-letter"` to their queue consumer, using the actual queue name if customized. Monitor this queue: [Cloudflare moves exhausted messages to the dead-letter queue](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), whose retention is finite. The encrypted R2 object remains available for recovery even after its queue reference expires, unless a bucket lifecycle rule removes it.

After correcting the underlying delivery failure, take the `objectKey` from a dead-letter message or the R2 listing and call the authenticated recovery endpoint. This example uses the inbound `WEBHOOK_SECRET` from the local environment file and prints only the response status:

```bash
node --env-file=.env --input-type=module <<'NODE'
const response = await fetch('https://mailbridge-worker.example.workers.dev/api/replay/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': process.env.WEBHOOK_SECRET },
  body: JSON.stringify({ objectKey: 'inbound/2026-10-21/replace-with-object-uuid.bin' })
});
console.log(response.status);
if (response.status !== 202) process.exitCode = 1;
NODE
```

Replace the Worker hostname and object key. HTTP 202 means the encrypted reference was queued again; acknowledge the old dead-letter entry after this succeeds. The outbound-only secret cannot authorize recovery. Deploy the backend receipt support before the new Worker, then verify with synthetic staging mail.

## Documentation

- [Wiki Home](https://github.com/imrasalghul/mailbridge/wiki)
- [Quick Start](https://github.com/imrasalghul/mailbridge/wiki/Quick-Start)
- [Architecture](https://github.com/imrasalghul/mailbridge/wiki/Architecture)
- [Inbound Delivery](https://github.com/imrasalghul/mailbridge/wiki/Inbound-Delivery)
- [Outbound Relay and Providers](https://github.com/imrasalghul/mailbridge/wiki/Outbound-Relay-and-Providers)
- [Spam and Reputation Filtering](https://github.com/imrasalghul/mailbridge/wiki/Spam-and-Reputation-Filtering)
- [Encrypted Queue and Audit](https://github.com/imrasalghul/mailbridge/wiki/Encrypted-Queue-and-Audit)
- [Configuration Reference](https://github.com/imrasalghul/mailbridge/wiki/Configuration-Reference)
- [Cloudflare Setup](https://github.com/imrasalghul/mailbridge/wiki/Cloudflare-Setup)
- [Deployment](https://github.com/imrasalghul/mailbridge/wiki/Deployment)
- [Testing and Operations](https://github.com/imrasalghul/mailbridge/wiki/Testing-and-Operations)
- [Troubleshooting](https://github.com/imrasalghul/mailbridge/wiki/Troubleshooting)

## Repository Layout

```text
server.js          Main Node.js backend
worker.js          Cloudflare Worker entrypoint
lib/               Crypto, queue, filtering, transport, and provider modules
test/              Node test suite
scripts/setup.js   Interactive configuration generator
Dockerfile         Production image
docker-compose.yml Local/runtime deployment
entrypoint.sh       Container startup and process supervision
```

This repository contains backend and Cloudflare edge code only; there is no browser frontend.

## Development

```bash
npm install
npm test
npm audit --omit=dev
npx --no-install wrangler deploy --dry-run --config wrangler.example.toml
```

For container changes:

```bash
docker compose up -d --build
docker logs -f mail-bridge
```

Preserve webhook authentication, ciphertext-only R2 storage, local private-key ownership, queue encryption, CIDR relay protections, and fail-closed filtering behavior. Add tests for changes to parsing, crypto, queues, spam logic, webhook handling, or providers.

See [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md) for repository-specific development guidance.

## License

See [LICENSE](LICENSE).
