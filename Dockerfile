FROM node:22.4-alpine AS builder

WORKDIR /build
COPY . /build

RUN yarn install
RUN yarn build

FROM node:alpine

RUN apk add autossh bash
WORKDIR /app
COPY --from=builder /build/config /app/config
COPY ./manager-container/entry_point.sh /entry_point.sh
RUN chmod +x /entry_point.sh
COPY --from=builder /build/dist /app
COPY --from=builder /build/node_modules /app/node_modules

ENTRYPOINT ["/entry_point.sh"]
