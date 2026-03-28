FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    build-essential \
    ca-certificates \
    curl \
    gnupg \
    python3 \
    spamassassin \
    spamc \
    && install -m 0755 -d /usr/share/keyrings \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list \
    && apt-get update \
    && apt-get install -y cloudflared nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/run/spamassassin /etc/default
RUN echo "ENABLED=1" > /etc/default/spamassassin
RUN echo 'OPTIONS="--create-prefs --max-children 5 --helper-home-dir"' >> /etc/default/spamassassin

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN chmod +x /app/entrypoint.sh

EXPOSE 3090 2525

ENTRYPOINT ["/app/entrypoint.sh"]
