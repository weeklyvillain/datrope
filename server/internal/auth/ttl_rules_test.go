package auth_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
)

func TestUploadTTLRules(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")
	var set auth.Settings
	admin.Do(http.MethodGet, "/api/admin/settings", nil, http.StatusOK, &set)
	require.Equal(t, []auth.TTLRule{}, set.UploadTTLRules)

	rules := []map[string]any{{"min_bytes": 100 << 20, "ttl_hours": 24 * 30}, {"min_bytes": 500 << 20, "ttl_hours": 24 * 7}}
	admin.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": rules}, http.StatusOK, &set)
	require.Equal(t, []auth.TTLRule{{MinBytes: 100 << 20, TTLHours: 720}, {MinBytes: 500 << 20, TTLHours: 168}}, set.UploadTTLRules)

	unsorted := []map[string]any{{"min_bytes": 500 << 20, "ttl_hours": 168}, {"min_bytes": 100 << 20, "ttl_hours": 720}}
	admin.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": unsorted}, http.StatusOK, &set)
	require.Equal(t, []auth.TTLRule{{MinBytes: 100 << 20, TTLHours: 720}, {MinBytes: 500 << 20, TTLHours: 168}}, set.UploadTTLRules, "stored ascending by size")

	six := make([]map[string]any, 6)
	for i := range six {
		six[i] = map[string]any{"min_bytes": (i + 2) << 20, "ttl_hours": 1}
	}
	admin.Fail(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": six}, http.StatusBadRequest, "VALIDATION_FAILED")
	admin.Fail(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": []map[string]any{{"min_bytes": 1000, "ttl_hours": 1}}}, http.StatusBadRequest, "VALIDATION_FAILED")
	admin.Fail(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": []map[string]any{{"min_bytes": 2 << 20, "ttl_hours": 1}, {"min_bytes": 2 << 20, "ttl_hours": 2}}}, http.StatusBadRequest, "VALIDATION_FAILED")
	admin.Fail(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": []map[string]any{{"min_bytes": 2 << 20, "ttl_hours": 9000}}}, http.StatusBadRequest, "VALIDATION_FAILED")

	admin.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": []map[string]any{}}, http.StatusOK, &set)
	require.Equal(t, []auth.TTLRule{}, set.UploadTTLRules)
}
