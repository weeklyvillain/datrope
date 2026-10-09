package channels_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/perms"
)

func groupNames(chs []channels.Channel, category *channels.Category) []string {
	out := []string{}
	for _, c := range chs {
		if (category == nil && c.CategoryID == nil) || (category != nil && c.CategoryID != nil && *c.CategoryID == category.ID) {
			out = append(out, c.Name)
		}
	}
	return out
}

func TestCategoriesAndOrdering(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	var games channels.Category
	alice.Do(http.MethodPost, "/api/server/categories", map[string]any{"name": "Games"}, http.StatusCreated, &games)
	ws.ExpectDispatch("CATEGORY_CREATE", nil)
	bob.Fail(http.MethodPost, "/api/server/categories", map[string]any{"name": "Mine"}, http.StatusForbidden, "MISSING_PERMISSION")

	a := alice.CreateTextChannel("a")
	b := alice.CreateTextChannel("b")
	c := alice.CreateTextChannel("c")
	for _, ch := range []string{a.String(), b.String(), c.String()} {
		alice.Do(http.MethodPatch, "/api/channels/"+ch, map[string]any{"category_id": games.ID.String()}, http.StatusOK, nil)
	}
	require.Equal(t, []string{"a", "b", "c"}, groupNames(alice.Channels(), &games))
	require.Equal(t, []string{"welcome", "general"}, groupNames(alice.Channels(), nil))

	// Move c to the top of the category; positions stay dense.
	alice.Do(http.MethodPatch, "/api/channels/"+c.String(), map[string]any{"position": 0}, http.StatusOK, nil)
	require.Equal(t, []string{"c", "a", "b"}, groupNames(alice.Channels(), &games))
	seen := map[int]bool{}
	for _, ch := range alice.Channels() {
		if ch.CategoryID != nil {
			require.False(t, seen[ch.Position])
			seen[ch.Position] = true
		}
	}

	// Topic.
	var updated channels.Channel
	alice.Do(http.MethodPatch, "/api/channels/"+a.String(), map[string]any{"topic": "Board games **only**"}, http.StatusOK, &updated)
	require.Equal(t, "Board games **only**", updated.Topic)

	// The welcome channel stays first and uncategorised.
	var welcome channels.Channel
	for _, ch := range alice.Channels() {
		if ch.Type == "welcome" {
			welcome = ch
		}
	}
	alice.Fail(http.MethodPatch, "/api/channels/"+welcome.ID.String(), map[string]any{"category_id": games.ID.String()}, http.StatusBadRequest, "WELCOME_STAYS")

	// Deleting a category moves its channels to the end of the uncategorised list.
	alice.Do(http.MethodDelete, "/api/server/categories/"+games.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"welcome", "general", "c", "a", "b"}, groupNames(alice.Channels(), nil))

	_, ready := bob.Connect()
	require.Empty(t, ready.Server.Categories)
}

func TestCategoryRenameAndReorder(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var one, two channels.Category
	alice.Do(http.MethodPost, "/api/server/categories", map[string]any{"name": "One"}, http.StatusCreated, &one)
	alice.Do(http.MethodPost, "/api/server/categories", map[string]any{"name": "Two"}, http.StatusCreated, &two)
	require.Equal(t, 0, one.Position)
	require.Equal(t, 1, two.Position)
	alice.Do(http.MethodPatch, "/api/server/categories/"+two.ID.String(), map[string]any{"position": 0, "name": "Second"}, http.StatusOK, &two)
	var list []channels.Category
	alice.Do(http.MethodGet, "/api/server/categories", nil, http.StatusOK, &list)
	require.Equal(t, "Second", list[0].Name)
	require.Equal(t, "One", list[1].Name)
}

func TestChannelMoves(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var cat channels.Category
	alice.Do(http.MethodPost, "/api/server/categories", map[string]any{"name": "Cat"}, http.StatusCreated, &cat)

	var x, y channels.Channel
	alice.Do(http.MethodPost, "/api/server/channels", map[string]any{"name": "x", "type": "text", "category_id": cat.ID.String()}, http.StatusCreated, &x)
	alice.Do(http.MethodPost, "/api/server/channels", map[string]any{"name": "y", "type": "voice", "category_id": cat.ID.String()}, http.StatusCreated, &y)
	require.Equal(t, 0, x.Position)
	require.Equal(t, 1, y.Position)
	alice.Fail(http.MethodPost, "/api/server/channels", map[string]any{"name": "z", "type": "text", "category_id": "1"}, http.StatusNotFound, "NOT_FOUND")
	alice.Fail(http.MethodPatch, "/api/channels/"+x.ID.String(), map[string]any{"category_id": "1"}, http.StatusNotFound, "NOT_FOUND")

	// Out of the category to index 0: it still lands below the welcome channel.
	alice.Do(http.MethodPatch, "/api/channels/"+x.ID.String(), map[string]any{"clear_category": true, "position": 0}, http.StatusOK, nil)
	require.Equal(t, []string{"welcome", "x", "general"}, groupNames(alice.Channels(), nil))
	require.Equal(t, []string{"y"}, groupNames(alice.Channels(), &cat))
	for _, ch := range alice.Channels() {
		if ch.Name == "y" {
			require.Equal(t, 0, ch.Position, "the old group is renumbered")
		}
	}

	welcome := alice.Channels()[0]
	require.Equal(t, "welcome", welcome.Type)
	alice.Fail(http.MethodPatch, "/api/channels/"+welcome.ID.String(), map[string]any{"position": 1}, http.StatusBadRequest, "WELCOME_STAYS")
	alice.Fail(http.MethodPatch, "/api/server/categories/1", map[string]any{"name": "n"}, http.StatusNotFound, "NOT_FOUND")
}

func TestDeleteChannelKeepsPositionsDense(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.CreateTextChannel("a")
	b := alice.CreateTextChannel("b")
	alice.CreateTextChannel("c")
	alice.Do(http.MethodDelete, "/api/channels/"+b.String(), nil, http.StatusNoContent, nil)
	alice.CreateTextChannel("d")

	chs := alice.Channels()
	require.Equal(t, []string{"welcome", "general", "a", "c", "d"}, groupNames(chs, nil))
	for i, ch := range chs {
		require.Equal(t, i, ch.Position, "%s sits at a dense, unique position", ch.Name)
	}
}

func TestMovePositionCountsOnlyVisibleChannels(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	var role communities.Role
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Mods", "permissions": uint64(perms.ManageChannels)}, http.StatusCreated, &role)
	alice.Do(http.MethodPut, "/api/server/members/"+bob.User.ID.String()+"/roles/"+role.ID.String(), nil, http.StatusNoContent, nil)

	alice.CreateTextChannel("a")
	hidden := alice.CreateTextChannel("hidden")
	alice.CreateTextChannel("b")
	c := alice.CreateTextChannel("c")
	alice.Do(http.MethodPut, "/api/channels/"+hidden.String()+"/overrides/member/"+bob.User.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ViewChannel)}, http.StatusOK, nil)
	require.Equal(t, []string{"welcome", "general", "a", "b", "c"}, groupNames(bob.Channels(), nil))

	// Bob sees welcome, general, a, b besides c; index 4 means "after b".
	bob.Do(http.MethodPatch, "/api/channels/"+c.String(), map[string]any{"position": 4}, http.StatusOK, nil)
	require.Equal(t, []string{"welcome", "general", "a", "hidden", "b", "c"}, groupNames(alice.Channels(), nil))

	// Index 2 means "right after general", ahead of the channel Bob cannot see.
	bob.Do(http.MethodPatch, "/api/channels/"+c.String(), map[string]any{"position": 2}, http.StatusOK, nil)
	chs := alice.Channels()
	require.Equal(t, []string{"welcome", "general", "c", "a", "hidden", "b"}, groupNames(chs, nil))
	for i, ch := range chs {
		require.Equal(t, i, ch.Position, "%s sits at a dense, unique position", ch.Name)
	}
}
