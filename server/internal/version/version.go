// Package version holds the build the binary was made from.
package version

// Build is the git commit the image was built from, set with
// -ldflags "-X github.com/datrope/datrope/server/internal/version.Build=<sha>"; "dev" otherwise.
var Build = "dev"
