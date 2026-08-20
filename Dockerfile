# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8545

# Mount your config: docker run -v $PWD/config.yaml:/app/config.yaml:ro ...
ENTRYPOINT ["node", "dist/index.js"]
CMD ["config.yaml"]
