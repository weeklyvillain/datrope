// Package lktest runs a LiveKit server in Docker for tests (spec section 10).
//
// One container starts per test binary. Rooms are named after channel IDs,
// which are unique, so tests never share a room. Only the voice package's
// tests may use it: the media ports are fixed, so two test binaries using
// it at once would collide. Docker must be running.
package lktest

import (
	"context"
	"fmt"
	"net"
	"os"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/datrope/datrope/server/internal/voice"
)

const (
	APIKey    = "datrope-test"
	APISecret = "datrope-test-secret-0123456789abcdef"
)

var (
	once     sync.Once
	cfg      voice.Config
	startErr error
)

// New returns a Config for the shared LiveKit server, starting it on first use.
func New(t *testing.T) voice.Config {
	t.Helper()
	once.Do(start)
	if startErr != nil {
		t.Fatalf("start livekit (is Docker running?): %v", startErr)
	}
	return cfg
}

// freePorts finds a TCP port and a UDP port nothing listens on. Test
// packages run in parallel, each with its own LiveKit, so fixed host ports
// would clash.
func freePorts() (tcp, udp string, err error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", "", err
	}
	defer l.Close()
	c, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		return "", "", err
	}
	defer c.Close()
	return strconv.Itoa(l.Addr().(*net.TCPAddr).Port), strconv.Itoa(c.LocalAddr().(*net.UDPAddr).Port), nil
}

func start() {
	tcpPort, udpPort, err := freePorts() // ICE over TCP; all WebRTC UDP traffic (UDP mux)
	if err != nil {
		startErr = err
		return
	}
	// See pgtest: without this, Ryuk cannot start on Docker Desktop for Windows.
	if runtime.GOOS == "windows" && os.Getenv("TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE") == "" {
		os.Setenv("TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE", "/var/run/docker.sock")
	}
	ctx := context.Background()
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "livekit/livekit-server:v1.13.7",
			ExposedPorts: []string{"7880/tcp", tcpPort + "/tcp", udpPort + "/udp"},
			HostConfigModifier: func(hc *container.HostConfig) {
				hc.PortBindings = network.PortMap{
					network.MustParsePort(tcpPort + "/tcp"): {{HostPort: tcpPort}},
					network.MustParsePort(udpPort + "/udp"): {{HostPort: udpPort}},
				}
			},
			Env: map[string]string{
				"LIVEKIT_KEYS": APIKey + ": " + APISecret,
				"NODE_IP":      "127.0.0.1",
				"UDP_PORT":     udpPort,
				"LIVEKIT_CONFIG": "rtc:\n  tcp_port: " + tcpPort + "\n  use_external_ip: false\n" +
					"room:\n  empty_timeout: 30\n  departure_timeout: 5\nlogging:\n  level: warn\n",
			},
			WaitingFor: wait.ForHTTP("/").WithPort("7880/tcp").WithStartupTimeout(2 * time.Minute),
		},
		Started: true,
	})
	if err != nil {
		startErr = err
		return
	}
	host, err := c.Host(ctx)
	if err != nil {
		startErr = err
		return
	}
	port, err := c.MappedPort(ctx, "7880/tcp")
	if err != nil {
		startErr = err
		return
	}
	addr := fmt.Sprintf("%s:%s", host, port.Port())
	cfg = voice.Config{URL: "http://" + addr, PublicURL: "ws://" + addr, APIKey: APIKey, APISecret: APISecret}
}

// Connect joins a room as a fake participant (no media is sent) and leaves
// it when the test ends.
func Connect(t *testing.T, cfg voice.Config, token string) *lksdk.Room {
	t.Helper()
	room, err := lksdk.ConnectToRoomWithToken(cfg.PublicURL, token, &lksdk.RoomCallback{}, lksdk.WithAutoSubscribe(false))
	if err != nil {
		t.Fatalf("connect to livekit: %v", err)
	}
	t.Cleanup(room.Disconnect)
	return room
}
