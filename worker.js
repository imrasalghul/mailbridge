let cachedPublicKeyPromise = null;
const DEFAULT_BRIDGE_WEBHOOK_PATH = "/api/webhook/email";
const INBOUND_PREFIX = "inbound/";
const FAILED_PREFIX = "failed/";
const STORED_OBJECT_KEY = /^(inbound|failed)\/\d{4}-\d{2}-\d{2}\/[a-zA-Z0-9-]+\.bin$/;
const PERMANENT_BRIDGE_STATUSES = [400, 406, 413, 422];
const DEFAULT_SWEEP_MIN_AGE_MINUTES = 60;
const DEFAULT_SWEEP_MAX_MESSAGES = 1000;
const QUEUE_SEND_BATCH_LIMIT = 100;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/replay/email") return handleReplayRequest(request, env);
    if (url.pathname !== "/api/send/email") {
      return new Response("Not found", { status: 404 });
    }

    return handleSendEmailRequest(request, env);
  },

  // Cron trigger: re-queue stored mail the queue's own retries gave up on (backend outage longer
  // than the retry window). Opt-in with MAILBRIDGE_SWEEP; relies on delivery receipts so a message
  // the backend already has is not delivered twice.
  async scheduled(controller, env, ctx) {
    if (!booleanSetting(env, "MAILBRIDGE_SWEEP", false)) return;
    ctx.waitUntil(sweepStoredMessages(env).catch((err) => {
      console.error("sweep failed", { message: err?.message || String(err) });
    }));
  },

  async email(message, env, ctx) {
    try {
      const senderIp = getEnvelopeSenderIp(message);
      const receivedAt = new Date().toISOString();
      const encryptionVersion = env.MAIL_STORE_ENCRYPTION_VERSION || "v1";

      const id = crypto.randomUUID();
      const objectKey = makeObjectKey({
        receivedAt,
        id,
      });

      console.log("email() start", {
        objectKey,
        rawSize: message.rawSize,
        encryptionVersion,
      });

      const rawField = await readRawMessage(message, getRawEncoding(env));
      const encryptedPayload = await encryptEnvelope({
        env,
        payload: {
          version: encryptionVersion,
          from: message.from || "",
          to: message.to || "",
          senderIp,
          ...rawField,
          receivedAt,
        },
        version: encryptionVersion,
      });

      await env.MAIL_STORE.put(objectKey, JSON.stringify(encryptedPayload), {
        httpMetadata: {
          contentType: "application/json",
        },
        customMetadata: {
          encryptionVersion,
          receivedAt,
        },
      });

      console.log("stored encrypted object in R2", { objectKey });

      await env.MAIL_QUEUE.send({
        objectKey,
        encryptionVersion,
      });

      console.log("queued message", { objectKey, encryptionVersion });
    } catch (err) {
      console.error("email() failed", {
        message: err?.message || String(err),
        stack: err?.stack || null,
      });
      throw err;
    }
  },

  async queue(batch, env, ctx) {
    for (const msg of batch.messages) {
      const payload = msg.body || {};
      const { objectKey, encryptionVersion } = payload;

      try {
        console.log("queue() processing", {
          objectKey,
          encryptionVersion: encryptionVersion || "legacy",
        });

        const object = await env.MAIL_STORE.get(objectKey);

        if (!object) {
          console.log("object missing, acking", { objectKey });
          msg.ack();
          continue;
        }

        const requestBody = await buildBridgeRequestBody({
          object,
          objectKey,
          payload,
        });

        const bridgeUrl = buildBridgeEndpointUrl(env.NODE_APP_URL);
        const transportOptions = buildBridgeTransportOptions(env);
        const response = await fetch(bridgeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Secret": env.WEBHOOK_SECRET,
            "X-Mailbridge-Delivery-Id": objectKey,
          },
          body: JSON.stringify(requestBody),
          ...transportOptions,
        });

        if (response.ok) {
          await env.MAIL_STORE.delete(objectKey);
          console.log("delivered and deleted", { objectKey });
          msg.ack();
          continue;
        }

        if (!PERMANENT_BRIDGE_STATUSES.includes(response.status)) {
          console.error("temporary bridge failure", {
            objectKey,
            status: response.status,
          });
          msg.retry({ delaySeconds: getRetryDelaySeconds(msg.attempts) });
          continue;
        }

        console.error("permanent bridge failure", {
          objectKey,
          status: response.status,
        });
        if (keepFailedMail(env)) {
          await keepFailedMessageOrRetry({ env, msg, objectKey, status: response.status });
        } else {
          await deleteStoredMessageOrRetry({
            env,
            msg,
            objectKey,
            reason: "permanent bridge failure",
          });
        }
      } catch (err) {
        console.error("queue() failed", {
          objectKey,
          message: err?.message || String(err),
          stack: err?.stack || null,
        });
        msg.retry({ delaySeconds: getRetryDelaySeconds(msg.attempts) });
      }
    }
  },
};

async function handleSendEmailRequest(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }
  if (!env.EMAIL?.send) {
    return jsonResponse({ error: "EMAIL binding is not configured" }, 500);
  }
  const sendWebhookSecret = env.CLOUDFLARE_SEND_WEBHOOK_SECRET || env.WEBHOOK_SECRET;
  if (!sendWebhookSecret) {
    return jsonResponse({ error: "CLOUDFLARE_SEND_WEBHOOK_SECRET or WEBHOOK_SECRET is not configured" }, 500);
  }
  if (request.headers.get("X-Webhook-Secret") !== sendWebhookSecret) {
    return jsonResponse({ error: "Invalid Secret" }, 403);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  try {
    const result = await env.EMAIL.send(payload);
    return jsonResponse({ success: true, messageId: result?.messageId || null });
  } catch (err) {
    const status = mapEmailSendErrorStatus(err);
    console.error("EMAIL.send failed", JSON.stringify({ status }));
    return jsonResponse({
      success: false,
      error: status === 400 ? "Email rejected by provider" : "Email provider temporarily unavailable",
    }, status);
  }
}

function mapEmailSendErrorStatus(err) {
  switch (err?.code) {
    case "E_RATE_LIMIT_EXCEEDED":
    case "E_DAILY_LIMIT_EXCEEDED":
      return 429;
    case "E_VALIDATION_ERROR":
    case "E_FIELD_MISSING":
    case "E_TOO_MANY_RECIPIENTS":
    case "E_TOO_MANY_ATTACHMENTS":
    case "E_RECIPIENT_SUPPRESSED":
    case "E_CONTENT_TOO_LARGE":
    case "E_HEADER_NOT_ALLOWED":
    case "E_HEADER_USE_API_FIELD":
    case "E_HEADER_VALUE_INVALID":
    case "E_HEADER_VALUE_TOO_LONG":
    case "E_HEADER_NAME_INVALID":
    case "E_HEADERS_TOO_LARGE":
    case "E_HEADERS_TOO_MANY":
      return 400;
    default:
      return 502;
  }
}

async function handleReplayRequest(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!env.WEBHOOK_SECRET) return jsonResponse({ error: "Server misconfiguration" }, 503);
  if (request.headers.get("X-Webhook-Secret") !== env.WEBHOOK_SECRET) return jsonResponse({ error: "Invalid Secret" }, 403);
  let payload;
  try { payload = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
  if (typeof payload?.objectKey !== "string" || !STORED_OBJECT_KEY.test(payload.objectKey)) {
    return jsonResponse({ error: "Invalid object key" }, 400);
  }
  try {
    const object = await env.MAIL_STORE.get(payload.objectKey);
    if (!object) return jsonResponse({ error: "Stored message not found" }, 404);
    if (object.customMetadata?.encryptionVersion !== "v1") return jsonResponse({ error: "Unsupported stored encryption version" }, 422);
    await env.MAIL_QUEUE.send({ objectKey: payload.objectKey, encryptionVersion: "v1" });
    return jsonResponse({ success: true }, 202);
  } catch {
    return jsonResponse({ error: "Recovery temporarily unavailable" }, 503);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function buildBridgeEndpointUrl(value) {
  if (!value) {
    throw new Error("NODE_APP_URL is not configured");
  }

  const url = new URL(value);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = DEFAULT_BRIDGE_WEBHOOK_PATH;
  }

  return url.toString();
}

function buildBridgeTransportOptions(env) {
  const profile = getProfile(env);
  let allowRedirects = profile === "legacy";
  const redirectSetting = String(env.MAILBRIDGE_HTTP_ALLOW_REDIRECTS ?? "").trim().toLowerCase();
  if (redirectSetting) {
    if (["true", "1", "yes", "on"].includes(redirectSetting)) allowRedirects = true;
    else if (["false", "0", "no", "off"].includes(redirectSetting)) allowRedirects = false;
    else throw new Error("Invalid MAILBRIDGE_HTTP_ALLOW_REDIRECTS");
  }
  const timeoutSetting = String(env.MAILBRIDGE_HTTP_TIMEOUT_MS ?? "").trim();
  const timeoutMs = timeoutSetting ? Number(timeoutSetting) : profile === "modern" ? 120000 : 0;
  if ((timeoutSetting && !/^\d+$/.test(timeoutSetting)) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 4294967295) {
    throw new Error("Invalid MAILBRIDGE_HTTP_TIMEOUT_MS");
  }
  return {
    redirect: allowRedirects ? "follow" : "error",
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  };
}

async function buildBridgeRequestBody({ object, objectKey, payload }) {
  if (payload?.encryptionVersion === "v1") {
    const encryptedPayload = JSON.parse(await object.text());
    return { encryptedPayload };
  }

  return {
    from: payload.from,
    to: payload.to,
    raw: await object.text(),
    senderIp: payload.senderIp,
  };
}

async function encryptEnvelope({ env, payload, version }) {
  const publicKey = await getPublicKey(env);
  const dataKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey(
    "raw",
    dataKeyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBytes },
    aesKey,
    plaintext
  );
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    dataKeyBytes
  );

  return {
    version,
    algorithm: "RSA-OAEP-256+A256GCM",
    wrappedKey: arrayBufferToBase64(wrappedKey),
    iv: arrayBufferToBase64(ivBytes),
    ciphertext: arrayBufferToBase64(ciphertext),
  };
}

async function getPublicKey(env) {
  if (!cachedPublicKeyPromise) {
    cachedPublicKeyPromise = crypto.subtle.importKey(
      "spki",
      pemToArrayBuffer(env.MAILBRIDGE_PUBLIC_KEY_PEM),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"]
    );
  }

  return cachedPublicKeyPromise;
}

async function deleteStoredMessageOrRetry({ env, msg, objectKey, reason }) {
  try {
    await env.MAIL_STORE.delete(objectKey);
    console.log("deleted object before ack", { objectKey, reason });
    msg.ack();
  } catch (err) {
    console.error("failed to delete object before ack", {
      objectKey,
      reason,
      message: err?.message || String(err),
      stack: err?.stack || null,
    });
    msg.retry({ delaySeconds: getRetryDelaySeconds(msg.attempts) });
  }
}

// Cloudflare already accepted the message, so the sender never gets a bounce: keep it under
// failed/ for the operator (replay with /api/replay/email, or delete by hand) instead of deleting it.
async function keepFailedMessageOrRetry({ env, msg, objectKey, status }) {
  try {
    const object = await env.MAIL_STORE.get(objectKey);
    if (object) {
      const failedKey = toFailedKey(objectKey);
      await env.MAIL_STORE.put(failedKey, await object.arrayBuffer(), {
        httpMetadata: object.httpMetadata,
        customMetadata: {
          ...object.customMetadata,
          failedStatus: String(status),
          failedAt: new Date().toISOString(),
        },
      });
      // A replayed failed/ object is rewritten in place: deleting it would lose the message.
      if (failedKey !== objectKey) await env.MAIL_STORE.delete(objectKey);
      console.log("kept failed object", { objectKey, failedKey, status });
    }
    msg.ack();
  } catch (err) {
    console.error("failed to keep failed object", {
      objectKey,
      message: err?.message || String(err),
      stack: err?.stack || null,
    });
    msg.retry({ delaySeconds: getRetryDelaySeconds(msg.attempts) });
  }
}

function toFailedKey(objectKey) {
  return objectKey.startsWith(INBOUND_PREFIX) ? FAILED_PREFIX + objectKey.slice(INBOUND_PREFIX.length) : objectKey;
}

async function sweepStoredMessages(env) {
  if (!(await backendIsHealthy(env))) {
    console.log("sweep skipped: backend not healthy");
    return { requeued: 0 };
  }
  const minAgeMinutes = numberSetting(env, "MAILBRIDGE_SWEEP_MIN_AGE_MINUTES", DEFAULT_SWEEP_MIN_AGE_MINUTES);
  const maxMessages = numberSetting(env, "MAILBRIDGE_SWEEP_MAX_MESSAGES", DEFAULT_SWEEP_MAX_MESSAGES);
  const cutoff = Date.now() - minAgeMinutes * 60_000;
  let cursor;
  let requeued = 0;
  do {
    const page = await env.MAIL_STORE.list({ prefix: INBOUND_PREFIX, cursor, limit: 1000, include: ["customMetadata"] });
    const due = page.objects
      .filter((o) => o.uploaded.getTime() < cutoff && o.customMetadata?.encryptionVersion === "v1")
      .slice(0, maxMessages - requeued);
    for (let i = 0; i < due.length; i += QUEUE_SEND_BATCH_LIMIT) {
      await env.MAIL_QUEUE.sendBatch(due.slice(i, i + QUEUE_SEND_BATCH_LIMIT).map((o) => ({
        body: { objectKey: o.key, encryptionVersion: "v1" },
      })));
    }
    requeued += due.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && requeued < maxMessages);
  if (requeued) console.log("sweep re-queued stored messages", { requeued });
  return { requeued };
}

// No queue operations are spent while the backend is down; the next run tries again.
async function backendIsHealthy(env) {
  try {
    const { redirect } = buildBridgeTransportOptions(env);
    const response = await fetch(new URL("/health", buildBridgeEndpointUrl(env.NODE_APP_URL)), {
      redirect,
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// "base64" keeps the message's exact bytes (8-bit mail in any charset, DKIM signatures intact).
// "text" is the earlier format: the message decoded as UTF-8, which older backends expect.
function getRawEncoding(env) {
  const value = String(env.MAILBRIDGE_RAW_ENCODING ?? "").trim().toLowerCase();
  if (value) {
    if (!["base64", "text"].includes(value)) throw new Error("Invalid MAILBRIDGE_RAW_ENCODING; use base64 or text");
    return value;
  }
  return getProfile(env) === "modern" ? "base64" : "text";
}

async function readRawMessage(message, encoding) {
  if (encoding === "text") return { raw: await new Response(message.raw).text() };
  return { rawBase64: bytesToBase64(new Uint8Array(await new Response(message.raw).arrayBuffer())) };
}

function keepFailedMail(env) {
  return booleanSetting(env, "MAILBRIDGE_KEEP_FAILED", getProfile(env) === "modern");
}

function getProfile(env) {
  const profile = String(env.MAILBRIDGE_BEHAVIOR_PROFILE || "legacy").trim().toLowerCase();
  if (!["legacy", "modern"].includes(profile)) throw new Error("Invalid MAILBRIDGE_BEHAVIOR_PROFILE");
  return profile;
}

function booleanSetting(env, name, fallback) {
  const value = String(env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new Error(`Invalid ${name}`);
}

function numberSetting(env, name, fallback) {
  const value = String(env[name] ?? "").trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${name}`);
  return Number(value);
}

function makeObjectKey({ receivedAt, id }) {
  const date = receivedAt.slice(0, 10);
  return `inbound/${date}/${id}.bin`;
}

function getEnvelopeSenderIp(message) {
  const rawValue = message?.headers?.get?.("x-envelope-remote-addr");
  if (!rawValue) return null;

  return String(rawValue)
    .trim()
    .replace(/^\[|\]$/g, "") || null;
}

function pemToArrayBuffer(pem) {
  const base64 = String(pem || "")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");

  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function arrayBufferToBase64(value) {
  return bytesToBase64(value instanceof Uint8Array ? value : new Uint8Array(value));
}

// Native when the runtime has it; otherwise 32 KiB chunks instead of one string append per byte,
// so messages of several MB stay within the Worker's CPU budget.
function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function getRetryDelaySeconds(attempts) {
  if (attempts <= 1) return 60;
  if (attempts === 2) return 120;
  if (attempts === 3) return 300;
  if (attempts === 4) return 600;
  return 1800;
}

export {
  buildBridgeEndpointUrl,
  bytesToBase64,
  DEFAULT_BRIDGE_WEBHOOK_PATH,
  sweepStoredMessages,
};
