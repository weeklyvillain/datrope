package auth

import "net/http"

const (
	// MaxBannerBytes caps the upload; the web app sends a 960 × 320 crop well below it.
	MaxBannerBytes = 1 << 20
	maxBannerSide  = 2048
)

// Banner handlers mirror the avatar ones: PUT/DELETE /api/users/@me/banner
// (behind RequireHTTP) and the public GET /api/banners/{userID}.
func (s *Service) BannerUploadHandler() http.Handler { return s.imageUploadHandler(bannerKind) }
func (s *Service) BannerDeleteHandler() http.Handler { return s.imageDeleteHandler(bannerKind) }
func (s *Service) BannerHandler() http.Handler       { return s.imageServeHandler(bannerKind) }
