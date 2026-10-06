FROM node:22-slim

# Dépendances système pour better-sqlite3 (compilation native)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Disque persistant Render monté sur /data (voir render.yaml)
ENV DB_PATH=/data/site.db
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
