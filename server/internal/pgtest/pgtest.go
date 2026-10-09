// Package pgtest gives each test its own migrated Postgres database.
//
// One container starts per test binary. The schema is migrated once into a
// template database; every New call clones it, which takes milliseconds.
// Docker must be running.
package pgtest

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/datrope/datrope/server/internal/db"
)

var (
	once     sync.Once
	baseURL  *url.URL
	startErr error
	cloneMu  sync.Mutex // CREATE DATABASE ... TEMPLATE fails when run concurrently
	counter  atomic.Int64
)

func New(t testing.TB) *pgxpool.Pool {
	t.Helper()
	once.Do(start)
	if startErr != nil {
		t.Fatalf("start postgres (is Docker running?): %v", startErr)
	}
	ctx := context.Background()
	name := fmt.Sprintf("test_%d", counter.Add(1))
	cloneMu.Lock()
	err := execIn(ctx, "postgres", "CREATE DATABASE "+name+" TEMPLATE datrope_template")
	cloneMu.Unlock()
	if err != nil {
		t.Fatalf("create database: %v", err)
	}
	pool, err := db.Open(ctx, urlFor(name))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func start() {
	// On Docker Desktop for Windows, testcontainers otherwise hands the reaper
	// (Ryuk) a Docker socket path it cannot use: Ryuk never starts, and test
	// containers are left behind after every run.
	if runtime.GOOS == "windows" && os.Getenv("TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE") == "" {
		os.Setenv("TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE", "/var/run/docker.sock")
	}
	ctx := context.Background()
	c, err := postgres.Run(ctx, "postgres:17-alpine",
		postgres.WithDatabase("postgres"),
		postgres.WithUsername("postgres"),
		postgres.WithPassword("postgres"),
		postgres.BasicWaitStrategies(),
	)
	if err != nil {
		startErr = err
		return
	}
	raw, err := c.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		startErr = err
		return
	}
	if baseURL, err = url.Parse(raw); err != nil {
		startErr = err
		return
	}
	if err := execIn(ctx, "postgres", "CREATE DATABASE datrope_template"); err != nil {
		startErr = err
		return
	}
	pool, err := db.Open(ctx, urlFor("datrope_template"))
	if err != nil {
		startErr = err
		return
	}
	defer pool.Close() // the template must have no open connections when cloned
	startErr = db.Migrate(ctx, pool)
}

func urlFor(name string) string {
	u := *baseURL
	u.Path = "/" + name
	return u.String()
}

func execIn(ctx context.Context, dbName, sql string) error {
	conn, err := pgx.Connect(ctx, urlFor(dbName))
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, sql)
	return err
}
