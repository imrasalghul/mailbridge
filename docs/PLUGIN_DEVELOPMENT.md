# Mailbridge Plugin Development

Mailbridge plugins are exact-version npm packages executed as isolated Node.js child processes. Runtime startup never installs or updates packages.

## Manifest

Place `mailbridge-plugin.json` in the package root:

```json
{
  "apiVersion": 1,
  "id": "example-headers",
  "version": "1.0.0",
  "type": "middleware",
  "failurePolicy": "fail-closed",
  "priority": 100,
  "entrypoint": "src/index.js",
  "config": {
    "HEADER_NAME": { "type": "string", "default": "X-Example" }
  },
  "secrets": {
    "API_TOKEN": { "type": "secret", "required": false }
  },
  "capabilities": ["raw_email"]
}
```

Types are `provider`, `scanner`, and `middleware`. Provider IDs are valid values for `RELAY_UPSTREAM_PROVIDER`. Scanner capabilities currently include `reputation` and `classification`. Middleware is ordered by ascending `priority`, then ID.

## JSON Lines protocol

Read one JSON object per line from stdin and write exactly one response line to stdout. Diagnostic logging belongs on stderr.

Requests contain `apiVersion`, `requestId`, `operation`, and `payload`. Responses contain the same `requestId`, `ok`, and either `result` or `error`. Supported lifecycle/data operations are `init`, `health`, `scan`, `deliver`, `transform`, and `shutdown`.

Provider `deliver` payloads contain `from`, `to`, base64 `rawInput`, and generic relay `context`. Scanner `scan` payloads contain the complete RFC822 message and relevant envelope/source metadata. Middleware `transform` payloads contain `from`, `to`, `rawEmail`, and `sourceIp`.

Middleware may return:

```json
{"action":"continue","rawEmail":"modified RFC822 message","from":"sender@example.com","to":"recipient@example.com"}
```

or:

```json
{"action":"reject","reason":"policy_name"}
```

Returning a modified complete RFC822 message supports adding/removing headers, parsing or stripping MIME attachments, redacting/searching body text, and other mail transformations.

## Configuration and security

Configuration is supplied only through `MAILBRIDGE_PLUGIN_CONFIG_JSON`; declared secrets are supplied through `MAILBRIDGE_PLUGIN_SECRETS_JSON`. The full Mailbridge environment is not inherited. Queue master keys, Mailbridge private keys, webhook secrets, and tunnel tokens are protected and cannot be declared by plugins.

Install packages with an exact version such as `example-mailbridge-plugin@1.2.3`. Tags, ranges, wildcards, and unversioned names are rejected. Installation disables npm lifecycle scripts, validates API/version metadata, records npm integrity in the lockfile, and keeps plugin code read-only to the runtime service.
