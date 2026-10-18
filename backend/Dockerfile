# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
RUN npx prisma generate && npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
COPY data ./data
USER node
EXPOSE 3000
# Apply pending migrations, then start the API (the auto-submit job runs inside it).
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/index.js"]
