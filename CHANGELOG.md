# Changelog

## Unreleased

### Delivery recovery

- Re-send stored mail after outages longer than the queue's retries: with `MAILBRIDGE_SWEEP` and a cron trigger, the Worker re-queues `inbound/` objects older than `MAILBRIDGE_SWEEP_MIN_AGE_MINUTES` once `GET /health` answers on the backend host. Fresh modern setup adds the setting and a 30-minute trigger when delivery receipts are on.
- Keep undeliverable mail instead of deleting it (`MAILBRIDGE_KEEP_FAILED`, modern default). The Worker moves rejected objects to `failed/` in R2 and the recovery endpoint accepts `failed/` keys. The local queue parks items at `QUEUE_MAX_ATTEMPTS` and retries them every `QUEUE_PARKED_RETRY_MINUTES`; permanent failures are parked without automatic retries. New `npm run queue` lists, retries and deletes queue items using metadata only.

### Message fidelity

- Keep each message's exact bytes (`MAILBRIDGE_RAW_ENCODING=base64`, modern default). 8-bit mail in charsets other than UTF-8 no longer loses characters or breaks its DKIM signature. The backend accepts both payload formats, adds its headers by editing only the header block, and sends SpamAssassin the original bytes.
- Encode Worker payloads in 32 KiB chunks (or natively where available) instead of one character at a time, so messages of several MB stay within the Worker's CPU budget.

### Upgrade notes

Deploy the backend before the Worker: a backend from an earlier release can't read `rawBase64` payloads. The queue database gains two columns (`parked_at`, `park_reason`) on start. Legacy environments keep the earlier behavior unless the settings above are set explicitly.

## 1.4.3 — 2026-10-23

### Security

- Update the Node.js runtime to 22.23.4, which fixes Node2Shell (CVE-2026-111497) and other security issues in the October 21 Node.js security release.
- Raise the supported runtime minimum to Node.js 22.23.4 and refresh the pinned Docker image, Debian package runtime, and CI runtime.

## 1.4.2 — 2026-10-21

### Security and reliability

- Remediate all 16 reported CodeQL alerts: safe HTTP errors, log encoding, cryptographic request identifiers, atomic file access, workflow permissions, and immutable action pins.
- Preserve setup secrets, installed plugin settings, custom runtime paths, and the active encryption key. Preserve Windows paths when writing environment files.
- Keep SMTP temporary failures retryable, accept null reverse-path senders, and distinguish permanent SMTP rejection from infrastructure failures.
- Add opt-in persistent delivery receipts for existing installations, enabled by default for fresh setup, including protection during rolling Worker upgrades and R2 cleanup retries. Keep undecryptable ciphertext available for recovery.
- Add a Cloudflare dead-letter queue and an authenticated endpoint for replaying encrypted R2 references.
- Keep blind recipients out of visible headers and preserve reply/threading headers.
- Prevent audit failures from causing duplicate delivery, serialize audit-chain writes, and handle early plugin exits without crashing the host.
- Exclude runtime mail, keys, databases, and live configuration from Docker build contexts.

### Plugins and compatibility

- Preserve existing environments and plugin interfaces through the default legacy profile; fresh setup selects modern behavior. Keep compatibility support for at least the next three releases without reverting security fixes or dependency pins.
- Add transactional exact-version plugin installs, upgrades, rollback, enable/disable, removal, and health commands, with full dependency locks and installed-file verification.
- Add strict response/configuration validation, namespaced secrets, and fail-closed discovery for unavailable enabled plugins in modern mode.
- Fix split UTF-8 output, supervise execution and shutdown, and add configurable concurrency, memory limits, and optional Docker isolation.
- Preserve existing setup quoting, custom paths, linked configuration, and Worker settings during upgrades. Document rollout flags and administration commands in the README.

### Dependencies and validation

- Refresh exact npm dependency pins and lockfile, including the follow-redirects security patch.
- Pin Node.js 22.23.3 container/runtime, Wrangler 4.151.3, and GitHub Actions release commits; update Worker compatibility date to 2026-10-21.
- Add Windows and Linux CI coverage and regression tests for delivery, setup, encryption, concurrency, and recovery.

### Upgrade notes

Existing environment files without `MAILBRIDGE_BEHAVIOR_PROFILE` keep legacy behavior. New setup and the example environment select `modern`; individual features can be enabled through environment settings. Node.js remains `>=22.23.3`. See [upgrade compatibility](README.md#upgrades-and-compatibility).

Deploy the backend before the Worker. When enabling delivery receipts, preserve `delivery-receipts.db` with the mail queue and key backups. Create a dead-letter queue before deploying a Worker configuration that references it; existing setup retains its queue configuration until explicitly opted in. See [delivery recovery](README.md#delivery-retries-and-recovery).
