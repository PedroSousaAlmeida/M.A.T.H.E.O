FROM oven/bun:1
ARG GIT_COMMIT
ENV GIT_COMMIT=$GIT_COMMIT
ENV NODE_ENV=production
WORKDIR /app
COPY package.json bun.lock tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build bunx --bun prisma generate
COPY src ./src
EXPOSE 3000
CMD ["sh", "-c", "bunx --bun prisma migrate deploy && bun run src/main.ts"]
