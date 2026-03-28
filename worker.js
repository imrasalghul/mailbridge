export default {
  async email(message, env, ctx) {
    try {
      const senderIp =
        message.headers?.get?.("x-envelope-remote-addr") || "0.0.0.0";
      const receivedAt = new Date().toISOString();

      const id = crypto.randomUUID();
      const objectKey = makeObjectKey({
        receivedAt,
        id,
        from: message.from,
        to: message.to,
      });

      console.log("email() start", {
        from: message.from,
        to: message.to,
        rawSize: message.rawSize,
        objectKey,
      });

      // Convert the email stream into a fixed-length buffer before storing in R2
      const rawBuffer = await new Response(message.raw).arrayBuffer();

      await env.MAIL_STORE.put(objectKey, rawBuffer, {
        httpMetadata: {
          contentType: "message/rfc822",
        },
        customMetadata: {
          from: message.from || "",
          to: message.to || "",
          senderIp,
          receivedAt,
          rawSize: String(message.rawSize || 0),
        },
      });

      console.log("stored in R2", { objectKey });

      await env.MAIL_QUEUE.send({
        objectKey,
        from: message.from || "",
        to: message.to || "",
        senderIp,
        receivedAt,
        rawSize: message.rawSize || 0,
      });

      console.log("queued message", { objectKey });
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
      const payload = msg.body;
      const { objectKey, from, to, senderIp } = payload;

      try {
        console.log("queue() processing", { objectKey });

        const object = await env.MAIL_STORE.get(objectKey);

        if (!object) {
          console.log("object missing, acking", { objectKey });
          msg.ack();
          continue;
        }

        const rawEmail = await object.text();

        const response = await fetch(env.NODE_APP_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Secret": env.WEBHOOK_SECRET,
          },
          body: JSON.stringify({
            from,
            to,
            raw: rawEmail,
            senderIp,
          }),
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

function makeObjectKey({ receivedAt, id, from, to }) {
  const date = receivedAt.slice(0, 10);
  return `inbound/${date}/${id}__from_${sanitizeForKey(from)}__to_${sanitizeForKey(to)}.eml`;
}

function sanitizeForKey(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]+/g, "_")
    .slice(0, 120);
}

function getRetryDelaySeconds(attempts) {
  if (attempts <= 1) return 60;
  if (attempts === 2) return 120;
  if (attempts === 3) return 300;
  if (attempts === 4) return 600;
  return 1800;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
