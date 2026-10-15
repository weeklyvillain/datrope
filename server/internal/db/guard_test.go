package db

import (
	"io/fs"
	"path"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// guardFrom: migrations up to this version predate the expand/contract rule.
const guardFrom = 42

var (
	sqlComment = regexp.MustCompile(`(?m)--.*$`)
	breakingRe = regexp.MustCompile(`(?i)\b(DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)|RENAME\b|SET\s+NOT\s+NULL|ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE|DELETE\s+FROM|TRUNCATE)\b`)
)

// breaking lists what in a migration's Up section the previous release might not survive.
func breaking(sql string) []string {
	if strings.Contains(sql, "-- datrope:contract") {
		return nil
	}
	up := sql
	if i := strings.Index(up, "-- +goose Down"); i >= 0 {
		up = up[:i]
	}
	up = sqlComment.ReplaceAllString(up, "")
	return breakingRe.FindAllString(up, -1)
}

func TestBreaking(t *testing.T) {
	require.Empty(t, breaking("-- +goose Up\nALTER TABLE a ADD COLUMN b TEXT;\n-- +goose Down\nALTER TABLE a DROP COLUMN b;"))
	require.Equal(t, []string{"DROP COLUMN"}, breaking("-- +goose Up\nALTER TABLE a DROP COLUMN b;"))
	require.NotEmpty(t, breaking("-- +goose Up\nALTER TABLE a ALTER COLUMN b SET NOT NULL;"))
	require.NotEmpty(t, breaking("-- +goose Up\nALTER TABLE a RENAME COLUMN b TO c;"))
	require.NotEmpty(t, breaking("-- +goose Up\nALTER TABLE a ALTER COLUMN b TYPE BIGINT;"))
	require.NotEmpty(t, breaking("-- +goose Up\nDELETE FROM a;"))
	require.NotEmpty(t, breaking("-- +goose Up\nTRUNCATE a;"))
	require.Empty(t, breaking("-- +goose Up\n-- drop column later\nCREATE TABLE a (id INT);"), "comments are ignored")
	require.Empty(t, breaking("-- +goose Up\n-- datrope:contract\nALTER TABLE a DROP COLUMN b;"))
}

// Every migration must work with the previous release's code: it runs while the old update slot
// still serves (deploy/README.md, "Updates"). See migrations/README.md.
func TestMigrationsAreBackwardCompatible(t *testing.T) {
	files, err := fs.Glob(migrations, "migrations/*.sql")
	require.NoError(t, err)
	require.NotEmpty(t, files)
	for _, p := range files {
		n, err := strconv.Atoi(strings.SplitN(path.Base(p), "_", 2)[0])
		require.NoError(t, err, p)
		if n <= guardFrom {
			continue
		}
		b, err := fs.ReadFile(migrations, p)
		require.NoError(t, err)
		require.Empty(t, breaking(string(b)), "%s breaks the running release: split it (expand now, contract next release) or mark it -- datrope:contract", p)
	}
}
