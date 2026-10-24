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

- Node.js 22.23.4 or newer (packaged runtime: 22.23.4)
- Docker with Docker Compose
- Cloudflare Email Routing, Workers, R2, and Queues
- A private SMTP server

Clone the repository, install dependencies, and start the interactive setup:

```bash
npm install
npm run setup
```

The assistant creates `.env`, `wrangler.toml`, runtime directories, independent webhook secrets, the local queue master key, and the RSA keypair used for encrypted R2 handoff. It asks before overwriting existing configuration. Reruns retain existing secrets, keypairs, provider selection, and plugin settings. Restore a missing queue master key from backup before running setup when queued mail exists; generating a replacement cannot decrypt that mail. Secret values are not printed in setup's deployment instructions.

Cloudflare Email Service is built in. Other providers and optional scanners require separately published plugins. Supply an existing, trusted package with an exact version; setup does not assume named example packages are available on npm. Unversioned packages, `latest`, and version ranges are rejected. Plugins run in supervised child processes. Modern mode supplies only declared settings and namespaced secrets; legacy mode preserves the older global-secret fallback for existing plugins.

Mailbridge discovers plugins from `MAILBRIDGE_PLUGIN_DIR` using `mailbridge-plugin.json`. A plugin declares one of three types:

- `provider`: receives `deliver` with the SMTP envelope and base64 RFC822 message.
- `scanner`: receives `scan`; capabilities such as `reputation` and `classification` determine when it runs.
- `middleware`: receives `transform` and may return a modified RFC822 message/envelope or reject delivery. This supports header editing, attachment removal, text inspection, redaction, and similar processing.

Middleware runs deterministically by manifest `priority`, then plugin ID. Plugins communicate over JSON Lines API version 1; the administration command can invoke an optional `health` operation. Configuration is namespaced in `MAILBRIDGE_PLUGIN_CONFIG_FILE`; secrets use `MAILBRIDGE_PLUGIN_<PLUGIN_ID>_<SECRET_NAME>` (uppercase plugin ID, with hyphens replaced by underscores). Protected Mailbridge encryption and webhook secrets cannot be requested by a plugin. The setup assistant accepts exact-version community packages and prompts from manifest configuration/secret schemas.

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

## Upgrades and compatibility

**New installations use the new behavior by default; compatibility is retained for existing installations.** Fresh setup and `.env.example` select `MAILBRIDGE_BEHAVIOR_PROFILE=modern`. An existing environment without that setting stays in `legacy`, and rerunning setup preserves that choice. Upgrading the package or container does not silently enable stricter plugin contracts or create a receipt database. Compatibility mode remains supported for at least the next three releases; any later removal will be announced before it takes effect.

Compatibility concerns configuration and plugin interfaces. Both profiles keep the current Node.js requirement and dependency pins, authenticated webhooks, encrypted storage, safe error responses, correct SMTP retries, Unicode handling, and fixes that prevent audit failures from duplicating delivery. Envelope-only outbound recipients remain hidden in Bcc in both profiles.

| Setting | Existing environment / `legacy` | Fresh setup / `modern` |
| --- | --- | --- |
| `MAILBRIDGE_PLUGIN_STRICT` | `false`: existing discovery, response conventions, global-secret fallback | `true`: explicit enabled registry, installed-file verification, typed configuration/responses, namespaced secrets |
| `MAILBRIDGE_DELIVERY_RECEIPTS` | `false`: repeated handoffs remain separate deliveries | `true`: durable deduplication and delivery-ID checks |
| `MAILBRIDGE_HTTP_ALLOW_REDIRECTS` | `true`: preserve redirect-based routes | `false`: require the final backend/Worker URL |
| `MAILBRIDGE_HTTP_TIMEOUT_MS` | No additional Worker handoff timeout | `120000` ms; `0` disables it |
| `MAILBRIDGE_LOG_FORMAT` | `text`, preserving prefixes with escaped control characters | `json` |
| `MAILBRIDGE_STRICT_FILE_READS` | `false`: preserve operator-configured file links during setup | `true`: reject linked setup configuration/key files |
| `MAILBRIDGE_DEAD_LETTER_QUEUE` | Setup retains an existing binding without requiring a new queue | Setup creates/configures a dead-letter queue |

Each setting can override the profile in `.env` (or `/etc/mailbridge/mailbridge.env` on Debian). Before enabling strict plugins, reinstall or upgrade each plugin to produce the full dependency lock and integrity inventory, configure namespaced secrets, and run its health check. Disable unused plugins explicitly. Legacy rollback snapshots without a full dependency lock remain usable in legacy mode.

Restart Mailbridge after environment changes. Worker settings are separate: setup copies the profile and HTTP overrides into `wrangler.toml`. For manual deployments, set those variables in the Worker's `[vars]` block or dashboard. Editing only the backend `.env` does not change an already-deployed Worker. Setup preserves existing Worker compatibility dates.

## Managing plugins

Run administration on the host owning the plugin files. Docker Compose mounts plugins read-only in the service; setup and these commands map `/app/data` paths back to the host's `data` directory.

```bash
npm run plugins -- list
npm run plugins -- install your-plugin-package@1.2.3
# Configure settings and namespaced secrets before enabling.
npm run plugins -- test your-plugin-id
npm run plugins -- enable your-plugin-id
npm run plugins -- disable your-plugin-id
npm run plugins -- upgrade your-plugin-package@1.2.4
npm run plugins -- rollback your-plugin-id
npm run plugins -- remove your-plugin-id
```

These package names are placeholders. On Debian, use `sudo /opt/mailbridge/node/bin/node /opt/mailbridge/app/scripts/plugins.js --system COMMAND ...`. `test` invokes `health` with an empty payload and does not send mail; plugins without that optional operation cannot pass the probe.

Installation disables npm lifecycle scripts, saves the complete dependency lock, and validates package/manifest versions and file hashes. New CLI installations start disabled; setup enables plugins explicitly selected and configured there. Upgrades stage an immutable release before atomically switching the registry. Failed activation leaves the previous release selected; rollback needs no download. Retired releases remain for rollback and running children; removal unregisters a plugin without deleting those files. If an interrupted operation leaves a `.operation` lock, remove it only after confirming its recorded process is no longer running.

In strict mode, missing or invalid enabled plugins temporarily stop affected processing instead of being skipped. Valid plugins retain their declared `fail-open` or `fail-closed` execution policy. Responses require boolean `ok`, object `result` on success, string `error` on failure, and the operation's documented result types. Middleware must return `action: "continue"` or `action: "reject"`.

Modern defaults allow four active processes, 100 waiting requests, a 15-second wait deadline, and a 128 MiB V8 old-space limit per child. Legacy leaves concurrency and heap limits disabled unless configured. Both retain the 15-second execution timeout. Overrides are `MAILBRIDGE_PLUGIN_MAX_CONCURRENT`, `MAILBRIDGE_PLUGIN_MAX_PENDING`, `MAILBRIDGE_PLUGIN_WAIT_TIMEOUT_MS`, `MAILBRIDGE_PLUGIN_MEMORY_MB`, and `MAILBRIDGE_PLUGIN_TIMEOUT_MS`. Limit failures follow the plugin's failure policy; a fail-closed failure remains retryable. The heap limit is not a total OS memory limit.

`GET /health` preserves the legacy response. Strict mode also returns HTTP 503 for unavailable enabled plugin files or required settings. Authenticated `GET /api/plugins/status`, using inbound `X-Webhook-Secret`, reports enabled versions, availability, active/pending counts, and execution failure codes without returning secrets or mail contents.

### Optional process isolation

Default `MAILBRIDGE_PLUGIN_SANDBOX=process` runs trusted plugins with the Mailbridge OS account's permissions. Child processes and restricted environments are not filesystem/network sandboxes. On Windows, descendants cannot always be terminated after their parent has already exited; use Docker isolation when process containment is required. On normal service shutdown, Mailbridge cancels pending plugin work and waits for active plugin cleanup before exiting.

On a host with a local Docker engine accessible to Mailbridge, `MAILBRIDGE_PLUGIN_SANDBOX=docker` runs each invocation in a disposable container. Only the plugin release is mounted read-only; keys, mail queues, and the Docker socket are not mounted. Containers use an unprivileged user, dropped capabilities, a read-only root, bounded CPU/memory/process counts, temporary storage, and disabled Docker log persistence. Cleanup removes the named container; Docker failure never silently falls back to process mode.

Pre-pull the digest-pinned Node image from the Mailbridge Dockerfile before enabling Docker execution (`--pull=never` is used). `MAILBRIDGE_PLUGIN_DOCKER_IMAGE` accepts only digest-pinned images. Networking defaults to `MAILBRIDGE_PLUGIN_DOCKER_NETWORK=none`; provider plugins need an explicitly configured network such as `bridge`. Host/container network sharing is rejected. Docker execution is optional on both profiles because an engine is not available to every backend installation.

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

The Worker supplies a stable delivery identity for each R2 object. With MAILBRIDGE_DELIVERY_RECEIPTS=true (the modern default), Mailbridge stores completed outcomes in `DATA_DIR/delivery-receipts.db`; repeated or concurrent handoffs reuse those outcomes. This prevents another SMTP delivery when the original HTTP response or R2 cleanup fails. Back up this database along with the queue and its keys, and retain it while an R2 object or queue reference might still be replayed. Receipts contain identifiers, hashes, and generic outcomes, not raw mail. SMTP itself cannot guarantee exactly-once delivery if the process crashes after the remote server accepts mail but before the receipt is saved, or if the SMTP acknowledgement is lost.

SMTP 4xx failures enter the encrypted local retry queue; SMTP 5xx rejections return HTTP 422. The Worker deletes rejected mail only for explicit HTTP 400, 406, 413, or 422 responses. Authentication, configuration, timeout, throttling, and server failures retry without deleting R2 ciphertext.

Fresh modern setup creates `mailbridge-inbound-dead-letter` before deployment. Existing installations can opt in with `MAILBRIDGE_DEAD_LETTER_QUEUE=true` when rerunning setup, or create the queue manually and add `dead_letter_queue = "mailbridge-inbound-dead-letter"` to their queue consumer, using the actual queue name if customized. Monitor this queue: [Cloudflare moves exhausted messages to the dead-letter queue](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), whose retention is finite. The encrypted R2 object remains available for recovery even after its queue reference expires, unless a bucket lifecycle rule removes it.

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

Replace the Worker hostname and object key. HTTP 202 means the encrypted reference was queued again; acknowledge the old dead-letter entry after this succeeds. The outbound-only secret cannot authorize recovery. Enable backend receipt support before replaying mail that might already have been accepted. Deploy the backend before the Worker when adopting modern behavior, then verify with synthetic staging mail. Legacy mode deliberately retains repeated-delivery semantics.

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
