FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts
RUN chmod +x /app/scripts/start.sh

RUN mkdir -p /app/runtime /app/config /data

ENV NODE_ENV=production
ENV HOME=/data
ENV CRONO_ENV_FILE=/app/config/.env

EXPOSE 8080

ENTRYPOINT ["/app/scripts/start.sh"]
