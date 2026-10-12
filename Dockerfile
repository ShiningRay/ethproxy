# Bun runs the TypeScript sources directly — no build stage needed.
FROM oven/bun:1-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

USER bun
EXPOSE 8545

# Mount your config: docker run -v $PWD/config.yaml:/app/config.yaml:ro ...
ENTRYPOINT ["bun", "src/index.ts"]
CMD ["config.yaml"]
