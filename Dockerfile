FROM node:24-bookworm-slim AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY docs/api/openapi.json /src/docs/api/openapi.json
COPY web/ ./
ARG PUBLIC_BASE_URL=http://localhost:8080
ENV PUBLIC_BASE_URL=$PUBLIC_BASE_URL
RUN pnpm build

FROM golang:1.26-bookworm AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /voices ./cmd/voices

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin voices
WORKDIR /app
COPY --from=backend /voices /usr/local/bin/voices
COPY --from=web /src/web/dist /app/web
ENV LISTEN_ADDR=0.0.0.0:8080 WEB_DIR=/app/web TEMP_DIR=/tmp
USER voices
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["voices", "healthcheck"]
ENTRYPOINT ["voices"]
