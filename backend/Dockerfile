# Build args for all downstream FROM images; explicit so fallback mirrors work.
ARG DOCKER_REGISTRY_PREFIX=

# Development stage
FROM ${DOCKER_REGISTRY_PREFIX:-}golang:1.25-alpine AS development

ARG GOPROXY
ARG APK_MIRROR

ENV GOPROXY=${GOPROXY:-https://proxy.golang.org,direct}

RUN if [ -n "$APK_MIRROR" ]; then sed -i "s|https://dl-cdn.alpinelinux.org/alpine|$APK_MIRROR|g" /etc/apk/repositories; fi \
 && apk add --no-cache gcc musl-dev sqlite-dev postgresql-client bash curl git

WORKDIR /app

ENV GOTOOLCHAIN=auto

ENV GOFLAGS=-p=1
RUN go install github.com/cosmtrek/air@v1.49.0 && rm -rf /root/.cache/go-build

COPY go.mod go.sum ./
RUN go mod download && rm -rf /go/pkg/mod/cache/download

COPY .air.toml ./

EXPOSE 8080

CMD ["air", "-c", ".air.toml"]

# Builder stage
FROM ${DOCKER_REGISTRY_PREFIX:-}golang:1.25-alpine AS builder

ARG GOPROXY
ARG APK_MIRROR

ENV GOPROXY=${GOPROXY:-https://proxy.golang.org,direct}

RUN if [ -n "$APK_MIRROR" ]; then sed -i "s|https://dl-cdn.alpinelinux.org/alpine|$APK_MIRROR|g" /etc/apk/repositories; fi \
 && apk add --no-cache gcc musl-dev sqlite-dev

WORKDIR /app

ENV GOTOOLCHAIN=auto
ENV GOWORK=off

COPY go.mod go.sum ./
RUN go mod download && rm -rf /go/pkg/mod/cache/download

COPY . .
RUN go mod vendor
RUN CGO_ENABLED=1 go build -mod=vendor -o /app/bin/server ./cmd/server

# Production stage
FROM ${DOCKER_REGISTRY_PREFIX:-}alpine:3.19 AS production

ARG APK_MIRROR

RUN if [ -n "$APK_MIRROR" ]; then sed -i "s|https://dl-cdn.alpinelinux.org/alpine|$APK_MIRROR|g" /etc/apk/repositories; fi \
 && apk add --no-cache ca-certificates sqlite-libs postgresql-libs

WORKDIR /app

COPY --from=builder /app/bin/server ./server
COPY --from=builder /app/sql/migrations ./sql/migrations

EXPOSE 8080

CMD ["./server"]