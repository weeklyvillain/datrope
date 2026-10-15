// Package db opens Postgres and runs the embedded migrations.
// Each package owns its tables; its migration file is named after it.
package db

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrations embed.FS

func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return pool, nil
}

func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	return migrate(pool, func(p *goose.Provider) error {
		_, err := p.Up(ctx)
		return err
	})
}

// MigrateTo runs the migrations up to and including version. Tests use it to
// load data into an older schema before migrating the rest of the way.
func MigrateTo(ctx context.Context, pool *pgxpool.Pool, version int64) error {
	return migrate(pool, func(p *goose.Provider) error {
		_, err := p.UpTo(ctx, version)
		return err
	})
}

// MigrateDownTo rolls the migrations back until version is the latest applied. Tests use it
// to check that a migration's Down section works on a database that has been in use.
func MigrateDownTo(ctx context.Context, pool *pgxpool.Pool, version int64) error {
	return migrate(pool, func(p *goose.Provider) error {
		_, err := p.DownTo(ctx, version)
		return err
	})
}

func migrate(pool *pgxpool.Pool, run func(*goose.Provider) error) error {
	fsys, err := fs.Sub(migrations, "migrations")
	if err != nil {
		return err
	}
	sqlDB := stdlib.OpenDBFromPool(pool)
	defer sqlDB.Close()
	p, err := goose.NewProvider(goose.DialectPostgres, sqlDB, fsys)
	if err != nil {
		return err
	}
	return run(p)
}

func IsUniqueViolation(err error) bool { return pgCode(err) == "23505" }

func IsForeignKeyViolation(err error) bool { return pgCode(err) == "23503" }

func pgCode(err error) string {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code
	}
	return ""
}
