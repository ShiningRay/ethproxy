FROM node:14-alpine AS builder
WORKDIR /usr/src/app
COPY package*.json yarn.lock ./
RUN yarn
COPY tsconfig*.json ./
COPY src src
RUN yarn run build

FROM node:14-alpine
ENV NODE_ENV=production
RUN apk add --no-cache tini
WORKDIR /usr/src/app
RUN chown node:node .
USER node
COPY package*.json yarn.lock ./
RUN yarn install --production
COPY --from=builder /usr/src/app/build/ build/
EXPOSE 3000
ENTRYPOINT [ "/sbin/tini","--", "node", "build/index.js" ]
