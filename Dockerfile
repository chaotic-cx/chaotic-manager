FROM node:alpine AS builder

WORKDIR /build
COPY . /build

RUN yarn install
RUN yarn build

FROM node:alpine

RUN apk add autossh
WORKDIR /app
COPY --from=builder /build/config /app/config
COPY ./entry_point.sh /entry_point.sh
RUN chmod +x /entry_point.sh
COPY --from=builder /build/dist /app
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/src/public /app/public

ENTRYPOINT ["/entry_point.sh"]
