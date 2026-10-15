package channels_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
)

func TestSystemDM(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	ctx := context.Background()

	dm, err := env.App.Channels.SystemDM(ctx, alice.User.ID)
	require.NoError(t, err)
	require.True(t, channels.IsSystemDM(dm))
	again, err := env.App.Channels.SystemDM(ctx, alice.User.ID)
	require.NoError(t, err)
	require.Equal(t, dm.ID, again.ID, "one conversation per user")

	var list []channels.Channel
	alice.Do(http.MethodGet, "/api/dms", nil, http.StatusOK, &list)
	require.Len(t, list, 1)
	var sys *auth.PublicUser
	for i, p := range list[0].Participants {
		if p.ID == auth.SystemUserID {
			sys = &list[0].Participants[i]
		}
	}
	require.NotNil(t, sys)
	require.True(t, sys.System)
	require.Equal(t, "System", sys.DisplayName)

	alice.Fail(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{auth.SystemUserID.String()}},
		http.StatusBadRequest, "INVALID_RECIPIENTS")
}
