# Changelog

## 1.4.2 — 2026-10-21

### Security and reliability

- Remediate all 16 reported CodeQL alerts: safe HTTP errors, log encoding, cryptographic request identifiers, atomic file access, workflow permissions, and immutable action pins.
- Preserve setup secrets, installed plugin settings, custom runtime paths, and the active encryption key. Preserve Windows paths when writing environment files.
- Keep SMTP temporary failures retryable, accept null reverse-path senders, and distinguish permanent SMTP rejection from infrastructure failures.
- Suppress repeat inbound deliveries with persistent receipts, including during rolling Worker upgrades and R2 cleanup retries. Keep undecryptable ciphertext available for recovery.
- Add a Cloudflare dead-letter queue and an authenticated endpoint for replaying encrypted R2 references.
- Keep blind recipients out of visible headers and preserve reply/threading headers.
- Prevent audit failures from causing duplicate delivery, serialize audit-chain writes, and handle early plugin exits without crashing the host.
- Exclude runtime mail, keys, databases, and live configuration from Docker build contexts.

### Dependencies and validation

- Refresh exact npm dependency pins and lockfile, including the follow-redirects security patch.
- Pin Node.js 22.23.3 container/runtime, Wrangler 4.151.3, and GitHub Actions release commits; update Worker compatibility date to 2026-10-21.
- Add Windows and Linux CI coverage and regression tests for delivery, setup, encryption, concurrency, and recovery.

### Upgrade notes

Deploy the backend before the Worker. Create the configured dead-letter queue before deploying the new Worker configuration. Preserve `delivery-receipts.db` with the mail queue and key backups. See [delivery recovery](README.md#delivery-retries-and-recovery).
