FROM golang:1.25-alpine AS build
ENV GOTOOLCHAIN=local
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/datrope ./cmd/datrope \
 && mkdir -p /out/data/files

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/datrope /datrope
# A new named volume mounted at /data copies this directory, owner included,
# so the nonroot user (65532) can write uploads.
COPY --from=build --chown=65532:65532 /out/data /data
ENV DATROPE_DATA_DIR=/data
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s CMD ["/datrope", "healthcheck"]
ENTRYPOINT ["/datrope"]
