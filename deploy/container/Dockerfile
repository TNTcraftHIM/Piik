FROM gcr.io/distroless/static-debian13:nonroot-amd64@sha256:e754765ad9e167b0677b41c617fd44afb7b9818a477f48f17bda08e12cfb98cb
WORKDIR /app
COPY --chmod=0555 screener-server /app/
COPY --chmod=0444 LICENSE THIRD-PARTY-NOTICES.txt REVISION /app/
ENV LISTEN_HOST=0.0.0.0 SCREENER_LOG_DIR=/home/nonroot/logs ROOM_DATABASE_PATH=/home/nonroot/rooms.sqlite
USER 65532:65532
EXPOSE 8787/tcp 3478/udp 3479/udp 3480/udp 7882/udp
ENTRYPOINT ["/app/screener-server"]
