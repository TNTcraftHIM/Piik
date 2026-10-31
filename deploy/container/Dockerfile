FROM gcr.io/distroless/cc-debian13:nonroot@sha256:3ee00291cf386ec52a552e6a858d555debd74776eb4bfa53fa3df2cd6677515e
ARG PIIK_VERSION=development
ARG PIIK_REVISION
ARG PIIK_SERVER_SHA256
LABEL org.opencontainers.image.title="Piik Server" \
      org.opencontainers.image.description="Private rooms with the shared Web UI and Rust media forwarding." \
      org.opencontainers.image.source="https://github.com/TNTcraftHIM/Piik" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=$PIIK_VERSION \
      org.opencontainers.image.revision=$PIIK_REVISION \
      tv.piik.server.sha256=$PIIK_SERVER_SHA256
WORKDIR /app
COPY --chmod=0555 piik-server /app/
COPY --chmod=0444 LICENSE THIRD-PARTY-NOTICES.txt REVISION /app/
COPY web/ /app/web/
ENV PIIK_CHANNEL_BIND_ADDRESS=0.0.0.0 PIIK_CHANNEL_PORT=8787 PIIK_CHANNEL_DATA_DIR=/home/nonroot
USER 65532:65532
EXPOSE 8787/tcp
ENTRYPOINT ["/app/piik-server"]
