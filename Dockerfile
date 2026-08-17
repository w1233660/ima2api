FROM docker.1ms.run/library/node:20-alpine

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY

ENV TZ=Asia/Shanghai \
    CHROME_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production

WORKDIR /app

RUN export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" all_proxy="$ALL_PROXY" \
    HTTP_PROXY="$HTTP_PROXY" HTTPS_PROXY="$HTTPS_PROXY" ALL_PROXY="$ALL_PROXY" \
    no_proxy="$NO_PROXY" NO_PROXY="$NO_PROXY" \
 && apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates

COPY package.json ./
RUN export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" all_proxy="$ALL_PROXY" \
    HTTP_PROXY="$HTTP_PROXY" HTTPS_PROXY="$HTTPS_PROXY" ALL_PROXY="$ALL_PROXY" \
    no_proxy="$NO_PROXY" NO_PROXY="$NO_PROXY" \
 && npm install --omit=dev

COPY server.js ima_client.js app.js ./
COPY public ./public
COPY config.example.json ./config.example.json

RUN mkdir -p /app/data \
 && chown -R node:node /app

USER node
EXPOSE 8080
CMD ["node", "app.js"]
