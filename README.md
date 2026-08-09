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

## Quick Start

Requirements:

- Node.js 22 or newer
- Docker with Docker Compose
- Cloudflare Email Routing, Workers, R2, and Queues
- A private SMTP server

Clone the repository, install dependencies, and start the interactive setup:

```bash
npm install
npm run setup
```

The assistant creates `.env`, `wrangler.toml`, runtime directories, independent webhook secrets, the local queue master key, and the RSA keypair used for encrypted R2 handoff. It asks before overwriting existing configuration.

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

The amd64 package supports Debian 11-13, Ubuntu 24.04/26.04, and Debian-based Proxmox Mail Gateway installations. On a Proxmox VE virtualization host, install Mailbridge in a dedicated Debian LXC or VM instead of directly on the hypervisor.

Install the repository signing key and select the current distribution codename:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.alghul.com/gpg.key \
  | sudo gpg --dearmor --yes -o /etc/apt/keyrings/mailbridge-archive-keyring.gpg

. /etc/os-release
case "$VERSION_CODENAME" in
  bullseye|bookworm|trixie|noble|resolute) ;;
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
npx wrangler deploy --dry-run --config wrangler.example.toml
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
