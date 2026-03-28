FROM node:22-trixie-slim AS deps

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ \
    make \
    python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    spamd \
    spamc \
    && install -m 0755 -d /usr/share/keyrings \
    && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
      > /etc/apt/sources.list.d/cloudflared.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends cloudflared \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/run/spamassassin /etc/default /app /app/data /app/data/queue /app/secrets \
    && echo "ENABLED=1" > /etc/default/spamassassin \
    && echo 'OPTIONS="--create-prefs --max-children 5 --helper-home-dir"' >> /etc/default/spamassassin \
    && chown -R node:node /var/run/spamassassin /app /home/node

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node . .

RUN chmod +x /app/entrypoint.sh

USER node

EXPOSE 3090 2525

ENTRYPOINT ["/app/entrypoint.sh"]
