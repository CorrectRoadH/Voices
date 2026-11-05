FROM --platform=$BUILDPLATFORM ghcr.io/voidzero-dev/vite-plus:1.3.0 AS web
USER root
RUN mkdir -p /src/web && chown -R vp:vp /src
USER vp
WORKDIR /src/web
COPY --chown=vp:vp web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN vp install --frozen-lockfile
COPY --chown=vp:vp docs/api/openapi.json /src/docs/api/openapi.json
COPY --chown=vp:vp web/ ./
ARG PUBLIC_BASE_URL=http://localhost:8080
ENV PUBLIC_BASE_URL=$PUBLIC_BASE_URL
RUN vp run build

# Native CGO build runs on the target platform (native CI runner or buildx QEMU).
FROM golang:1.26-bookworm AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY scripts/package-native.sh ./scripts/package-native.sh
COPY docs/release-package.txt ./docs/release-package.txt
ARG VOICES_VERSION=dev
RUN VOICES_VERSION="$VOICES_VERSION" ./scripts/package-native.sh /package

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates libstdc++6 libgcc-s1 && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin voices

# Exercise the shipped libraries and embedded model without Go/cache/Python.
FROM runtime AS native-test
WORKDIR /verify
COPY --from=backend /package/ ./
USER voices
RUN ./native-test -test.run '^TestVoiceprintNative' -test.v && touch /tmp/native-verified

FROM scratch AS package
COPY --from=backend /package/voices /voices
COPY --from=backend /package/lib/ /lib/
COPY --from=backend /package/licenses/ /licenses/
COPY --from=backend /package/README.txt /README.txt
COPY --from=web /src/web/dist/ /web/
COPY --from=native-test /tmp/native-verified /native-verified

FROM runtime AS app
WORKDIR /app
COPY --from=package / /app/
ENV PATH="/app:${PATH}" LISTEN_ADDR=0.0.0.0:8080 WEB_DIR=/app/web TEMP_DIR=/tmp
USER voices
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["voices", "healthcheck"]
ENTRYPOINT ["voices"]
