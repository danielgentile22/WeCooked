FROM node:22-slim AS build
# better-sqlite3 compiles from source
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# Pin to the same version used for the laptop restore drill (docs/RUNBOOK.md)
COPY --from=litestream/litestream:0.5.11 /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=build /app/build build
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json .
COPY migrations migrations
COPY litestream.yml /etc/litestream.yml
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh
EXPOSE 3000
CMD ["./docker-entrypoint.sh"]
