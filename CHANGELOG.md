# Changelog

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
