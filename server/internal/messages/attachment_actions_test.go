package messages_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestAttachmentKeepAndRemove(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	a := bob.Upload(ch, "notes.txt", []byte("hello"), http.StatusCreated)
	bob.SendWith(ch, "file", a.ID)
	path := "/api/attachments/" + a.ID.String()

	ws, _ := alice.Connect()
	var upd struct {
		Attachments []files.Attachment `json:"attachments"`
	}
	var got files.Attachment
	bob.Do(http.MethodPatch, path, map[string]any{"keep": true}, http.StatusOK, &got)
	require.True(t, got.Keep)
	ws.ExpectDispatch("MESSAGE_UPDATE", &upd)
	require.True(t, upd.Attachments[0].Keep)

	carol := env.Register("carol")
	carol.Join(alice.Invite())
	carol.Fail(http.MethodPatch, path, map[string]any{"keep": false}, http.StatusForbidden, "MISSING_PERMISSION")
	carol.Fail(http.MethodDelete, path, nil, http.StatusForbidden, "MISSING_PERMISSION")

	alice.Do(http.MethodPatch, path, map[string]any{"keep": false}, http.StatusOK, &got) // the owner outranks bob
	require.False(t, got.Keep)

	ws.ExpectDispatch("MESSAGE_UPDATE", &upd) // from the keep=false PATCH
	require.False(t, upd.Attachments[0].Keep)
	alice.Do(http.MethodDelete, path, nil, http.StatusNoContent, nil)
	ws.ExpectDispatch("MESSAGE_UPDATE", &upd)
	require.True(t, upd.Attachments[0].Expired)
	bob.Fail(http.MethodGet, a.URL, nil, http.StatusGone, "FILE_EXPIRED")
	bob.Do(http.MethodDelete, path, nil, http.StatusNoContent, nil) // already gone: no-op

	draft := bob.Upload(ch, "draft.txt", []byte("x"), http.StatusCreated)
	bob.Fail(http.MethodPatch, "/api/attachments/"+draft.ID.String(), map[string]any{"keep": true}, http.StatusNotFound, "NOT_FOUND")
}

func TestAttachmentActionsFollowHierarchy(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	carol := env.Register("carol")
	var helper, mod struct{ ID id.ID }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Helper", "permissions": uint64(perms.ManageMessages)}, http.StatusCreated, &helper)
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Moderator", "permissions": uint64(perms.ManageMessages)}, http.StatusCreated, &mod)
	alice.Do(http.MethodPut, "/api/server/members/"+carol.User.ID.String()+"/roles/"+helper.ID.String(), nil, http.StatusNoContent, nil) // rank 1
	alice.Do(http.MethodPut, "/api/server/members/"+bob.User.ID.String()+"/roles/"+mod.ID.String(), nil, http.StatusNoContent, nil)      // rank 2

	a := bob.Upload(ch, "notes.txt", []byte("hello"), http.StatusCreated)
	bob.SendWith(ch, "file", a.ID)
	path := "/api/attachments/" + a.ID.String()
	// carol may manage messages but doesn't outrank the uploader.
	carol.Fail(http.MethodPatch, path, map[string]any{"keep": true}, http.StatusForbidden, "MISSING_PERMISSION")
	carol.Fail(http.MethodDelete, path, nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Do(http.MethodGet, a.URL, nil, http.StatusOK, nil)
}
