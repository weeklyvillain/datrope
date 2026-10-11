FROM golang:1.25-alpine AS build
ENV GOTOOLCHAIN=local
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/updater ./cmd/updater

# git pulls the checkout, docker compose rebuilds the stack, su-exec runs git as the
# checkout's owner. Runs as root: it needs the Docker socket anyway.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates git docker-cli docker-cli-compose docker-cli-buildx su-exec
ENV HOME=/tmp
COPY --from=build /out/updater /updater
ENTRYPOINT ["/updater"]
