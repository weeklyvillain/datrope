package integrations

import (
	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/httpx"
)

func Register(api huma.API, s *Service) {
	tags := []string{"integrations"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	registerAlerts(api, s, op)
	registerConnections(api, s, op)
}
