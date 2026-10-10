FROM golang:1.25-alpine AS build
ENV GOTOOLCHAIN=local
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/datrope ./cmd/datrope \
 && mkdir -p /out/data/files

# Alpine rather than distroless: the music bot runs ffmpeg (decoding to Opus)
# and yt-dlp (YouTube links and searches).
FROM alpine:3.20
RUN apk add --no-cache ca-certificates ffmpeg yt-dlp && adduser -D -H -u 65532 nonroot
USER 65532:65532
COPY --from=build /out/datrope /datrope
# A new named volume mounted at /data copies this directory, owner included,
# so the nonroot user (65532) can write uploads.
COPY --from=build --chown=65532:65532 /out/data /data
ENV DATROPE_DATA_DIR=/data
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s CMD ["/datrope", "healthcheck"]
ENTRYPOINT ["/datrope"]
