FROM node:24-alpine AS builder

WORKDIR /build
COPY package.json yarn.lock .yarnrc.yml /build/
RUN corepack enable && yarn install
COPY . /build
RUN yarn build

FROM node:24-alpine

RUN apk add autossh bash gawk
WORKDIR /app
COPY --from=builder /build/config /app/config
COPY ./manager-container/entry_point.sh /entry_point.sh
RUN chmod +x /entry_point.sh
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/dist /app

ENTRYPOINT ["/entry_point.sh"]
