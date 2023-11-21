
FROM node:alpine AS builder
WORKDIR /build
COPY . /build
RUN yarn install
RUN yarn build

FROM node:alpine
WORKDIR /app
COPY --from=builder /build/dist /app
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/config /app/config
ENTRYPOINT [ "node", "/app/index.js" ]
