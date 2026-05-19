let cachedPublicKeyPromise = null;
const DEFAULT_BRIDGE_WEBHOOK_PATH = "/api/webhook/email";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/send/email") {
      return new Response("Not found", { status: 404 });
    }

    return handleSendEmailRequest(request, env);
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

      const rawText = await new Response(message.raw).text();
      const encryptedPayload = await encryptEnvelope({
        env,
        payload: {
          version: encryptionVersion,
          from: message.from || "",
          to: message.to || "",
          senderIp,
          raw: rawText,
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
        const response = await fetch(bridgeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Secret": env.WEBHOOK_SECRET,
          },
          body: JSON.stringify(requestBody),
        });

        if (response.ok) {
          await env.MAIL_STORE.delete(objectKey);
          console.log("delivered and deleted", { objectKey });
          msg.ack();
          continue;
        }

        const errorText = await safeReadText(response);

        if (response.status >= 500 || response.status === 429) {
          console.error("temporary bridge failure", {
            objectKey,
            status: response.status,
            errorText,
          });
          msg.retry({ delaySeconds: getRetryDelaySeconds(msg.attempts) });
          continue;
        }

        console.error("permanent bridge failure", {
          objectKey,
          status: response.status,
          errorText,
        });
        await deleteStoredMessageOrRetry({
          env,
          msg,
          objectKey,
          reason: "permanent bridge failure",
        });
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
  if (!env.WEBHOOK_SECRET) {
    return jsonResponse({ error: "WEBHOOK_SECRET is not configured" }, 500);
  }
  if (request.headers.get("X-Webhook-Secret") !== env.WEBHOOK_SECRET) {
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
    console.error("EMAIL.send failed", {
      code: err?.code || null,
      message: err?.message || String(err),
    });
    return jsonResponse({
      success: false,
      code: err?.code || null,
      error: err?.message || String(err),
    }, status);
  }
}

function mapEmailSendErrorStatus(err) {
  switch (err?.code) {
    case "E_RATE_LIMIT_EXCEEDED":
    case "E_DAILY_LIMIT_EXCEEDED":
      return 429;
    case "E_INTERNAL_SERVER_ERROR":
    case "E_DELIVERY_FAILED":
      return 502;
    default:
      return 400;
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
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
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
  DEFAULT_BRIDGE_WEBHOOK_PATH,
};

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
