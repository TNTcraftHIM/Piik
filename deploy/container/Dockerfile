FROM gcr.io/distroless/static-debian13:nonroot-amd64@sha256:e754765ad9e167b0677b41c617fd44afb7b9818a477f48f17bda08e12cfb98cb
ARG PIIK_VERSION=development
ARG PIIK_REVISION
ARG PIIK_SERVER_SHA256
LABEL org.opencontainers.image.title="Piik Server" \
      org.opencontainers.image.description="Private screen sharing with Web, signaling, STUN and optional media fallback." \
      org.opencontainers.image.source="https://github.com/TNTcraftHIM/Piik" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=$PIIK_VERSION \
      org.opencontainers.image.revision=$PIIK_REVISION \
      tv.piik.server.sha256=$PIIK_SERVER_SHA256
WORKDIR /app
COPY --chmod=0555 piik-server /app/
COPY --chmod=0444 LICENSE THIRD-PARTY-NOTICES.txt REVISION /app/
ENV LISTEN_HOST=0.0.0.0 PIIK_LOG_DIR=/home/nonroot/logs ROOM_DATABASE_PATH=/home/nonroot/rooms.sqlite
USER 65532:65532
EXPOSE 8787/tcp 3478/udp 3479/udp 3480/udp 7882/udp
ENTRYPOINT ["/app/piik-server"]
