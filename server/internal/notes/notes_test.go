package notes_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/notes"
)

func doc(text string) map[string]any {
	return map[string]any{"type": "doc", "content": []any{
		map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": text}}},
	}}
}

func create(t *testing.T, c *apptest.Client, title, text string) notes.Note {
	t.Helper()
	var n notes.Note
	c.Do(http.MethodPost, "/api/notes", map[string]any{"title": title, "content": doc(text), "text": text}, http.StatusCreated, &n)
	return n
}

func list(t *testing.T, c *apptest.Client, q string) []notes.NoteSummary {
	t.Helper()
	var out []notes.NoteSummary
	path := "/api/notes"
	if q != "" {
		path += "?q=" + q
	}
	c.Do(http.MethodGet, path, nil, http.StatusOK, &out)
	return out
}

func titles(ns []notes.NoteSummary) []string {
	out := []string{}
	for _, n := range ns {
		out = append(out, n.Title)
	}
	return out
}

func TestNoteCRUD(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")

	var blank notes.Note
	alice.Do(http.MethodPost, "/api/notes", map[string]any{"title": "   "}, http.StatusCreated, &blank)
	require.Equal(t, "", blank.Title)
	require.Equal(t, "doc", blank.Content["type"], "missing content becomes an empty doc")
	require.Equal(t, blank.ID.Time().UnixMilli(), blank.CreatedAt.UnixMilli())

	time.Sleep(5 * time.Millisecond)
	a := create(t, alice, " Raid ", "tank: kalle\n\n  healer   x2")
	require.Equal(t, "Raid", a.Title)
	require.Equal(t, []string{"Raid", ""}, titles(list(t, alice, "")), "newest first")
	require.Equal(t, "tank: kalle healer x2", list(t, alice, "")[0].Preview)

	path := "/api/notes/" + a.ID.String()
	var got notes.Note
	alice.Do(http.MethodGet, path, nil, http.StatusOK, &got)
	require.Equal(t, a.Text, got.Text)

	time.Sleep(5 * time.Millisecond)
	alice.Do(http.MethodPatch, "/api/notes/"+blank.ID.String(), map[string]any{"title": "Movies"}, http.StatusOK, &got)
	require.Equal(t, "Movies", got.Title)
	require.True(t, got.UpdatedAt.After(blank.UpdatedAt))
	require.Equal(t, []string{"Movies", "Raid"}, titles(list(t, alice, "")), "an edit moves it to the top")

	alice.Do(http.MethodPatch, path, map[string]any{"content": doc("long"), "text": "long"}, http.StatusOK, &got)
	require.Equal(t, "long", got.Text)
	require.Equal(t, "Raid", got.Title, "title kept when not sent")

	alice.Do(http.MethodDelete, path, nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodGet, path, nil, http.StatusNotFound, "NOT_FOUND")
	require.Equal(t, []string{"Movies"}, titles(list(t, alice, "")))
}

func TestNotesArePrivate(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	a := create(t, alice, "secret", "shh")
	path := "/api/notes/" + a.ID.String()

	require.Empty(t, list(t, bob, ""))
	bob.Fail(http.MethodGet, path, nil, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodPatch, path, map[string]any{"title": "mine"}, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodDelete, path, nil, http.StatusNotFound, "NOT_FOUND")
	require.Equal(t, []string{"secret"}, titles(list(t, alice, "")))
}

func TestNoteValidation(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	a := create(t, alice, "ok", "")
	path := "/api/notes/" + a.ID.String()

	alice.Fail(http.MethodPost, "/api/notes", map[string]any{"title": strings.Repeat("é", 101)}, http.StatusBadRequest, "NOTE_TITLE_TOO_LONG")
	alice.Do(http.MethodPost, "/api/notes", map[string]any{"title": strings.Repeat("é", 100)}, http.StatusCreated, nil)
	alice.Fail(http.MethodPatch, path, map[string]any{"content": map[string]any{"type": "paragraph"}, "text": ""}, http.StatusBadRequest, "NOTE_INVALID_CONTENT")
	alice.Fail(http.MethodPatch, path, map[string]any{"content": doc("x")}, http.StatusBadRequest, "NOTE_INVALID_CONTENT")
	alice.Fail(http.MethodPatch, path, map[string]any{"text": "x"}, http.StatusBadRequest, "NOTE_INVALID_CONTENT")
	big := strings.Repeat("a", 200*1024+1)
	alice.Fail(http.MethodPatch, path, map[string]any{"content": doc(big), "text": "a"}, http.StatusBadRequest, "NOTE_TOO_LARGE")
	alice.Fail(http.MethodPatch, path, map[string]any{"content": doc("a"), "text": big}, http.StatusBadRequest, "NOTE_TOO_LARGE")
}

func TestNoteLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	for range 500 {
		alice.Do(http.MethodPost, "/api/notes", map[string]any{}, http.StatusCreated, nil)
	}
	alice.Fail(http.MethodPost, "/api/notes", map[string]any{}, http.StatusBadRequest, "NOTE_LIMIT")
}

func TestNoteSearch(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	create(t, alice, "Raid roster", "tank kalle")
	create(t, alice, "Movies", "Dune, ARRIVAL")
	create(t, alice, "Percent", "100% sure")
	create(t, alice, "Plain", "100 sure")

	require.Equal(t, []string{"Raid roster"}, titles(list(t, alice, "raid")))
	require.Equal(t, []string{"Movies"}, titles(list(t, alice, "arrival")), "text, case-insensitive")
	require.Equal(t, []string{"Percent"}, titles(list(t, alice, "100%25")), "% is literal")
	require.Empty(t, list(t, alice, "_ure"), "_ is literal")
}

func TestNoteEventsReachOnlyTheOwner(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	aws, _ := alice.Connect()
	bws, _ := bob.Connect()

	a := create(t, alice, "n", "")
	var sum notes.NoteSummary
	aws.ExpectDispatch("NOTE_CREATE", &sum)
	require.Equal(t, a.ID, sum.ID)

	alice.Do(http.MethodPatch, "/api/notes/"+a.ID.String(), map[string]any{"title": "m"}, http.StatusOK, nil)
	var upd notes.Note
	aws.ExpectDispatch("NOTE_UPDATE", &upd)
	require.Equal(t, "m", upd.Title)

	alice.Do(http.MethodDelete, "/api/notes/"+a.ID.String(), nil, http.StatusNoContent, nil)
	var del notes.NoteDeleted
	aws.ExpectDispatch("NOTE_DELETE", &del)
	require.Equal(t, a.ID, del.ID)

	bws.ExpectNoDispatch("NOTE_CREATE", 200*time.Millisecond)
	bws.ExpectNoDispatch("NOTE_UPDATE", 100*time.Millisecond)
	bws.ExpectNoDispatch("NOTE_DELETE", 100*time.Millisecond)
}

func TestEmptyNoteUpdateChangesNothing(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	aws, _ := alice.Connect()
	a := create(t, alice, "keep", "text")
	aws.ExpectDispatch("NOTE_CREATE", nil)

	var got notes.Note
	alice.Do(http.MethodPatch, "/api/notes/"+a.ID.String(), map[string]any{}, http.StatusOK, &got)
	require.Equal(t, "keep", got.Title)
	require.True(t, got.UpdatedAt.Equal(a.UpdatedAt), "updated_at not bumped")
	aws.ExpectNoDispatch("NOTE_UPDATE", 200*time.Millisecond)

	bob := env.Register("bob")
	bob.Fail(http.MethodPatch, "/api/notes/"+a.ID.String(), map[string]any{}, http.StatusNotFound, "NOT_FOUND")
}
