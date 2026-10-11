package expressions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/datrope/datrope/server/internal/httpx"
)

// DefaultSevenTVURL is 7TV's API; its v4 GraphQL endpoint needs no key.
// Tests point the service at a fake instead.
const DefaultSevenTVURL = "https://7tv.io"

const (
	sevenTVPerPage = 48
	sevenTVMaxPage = 50
	maxGQLBody     = 8 << 20 // an emote set of 1000 emotes is about 1 MB
)

// sevenTVID is an emote or emote set ID: a ULID, or a legacy 24-digit hex ObjectID.
var sevenTVID = regexp.MustCompile(`^(?:[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}|[0-9a-fA-F]{24})$`)

var errSevenTV = errors.New("7tv request failed")

// SevenTVEmote is one emote found on 7TV. Clients load PreviewURL straight from 7TV's CDN.
type SevenTVEmote struct {
	ID         string `json:"id" doc:"Pass to POST /api/server/emoji/7tv"`
	Name       string `json:"name" doc:"Its name on 7TV (or its alias in the set); may not be a valid emoji name"`
	Animated   bool   `json:"animated"`
	PreviewURL string `json:"preview_url" doc:"A 1x (about 32 px tall) WebP on 7TV's CDN"`
}

type SevenTVPage struct {
	Items    []SevenTVEmote `json:"items"`
	NextPage int            `json:"next_page,omitempty" doc:"Pass as page to get the next page; absent on the last page"`
}

type SevenTVSet struct {
	ID    string         `json:"id"`
	Name  string         `json:"name"`
	Items []SevenTVEmote `json:"items"`
}

type ImportSevenTVRequest struct {
	EmoteID string `json:"emote_id" doc:"A 7TV emote ID"`
	Name    string `json:"name" pattern:"^[A-Za-z0-9_]{2,32}$"`
}

func sevenTVError() *httpx.Error {
	return httpx.E(http.StatusBadGateway, "EMOTE_PROVIDER_ERROR", "couldn't reach 7TV, try again")
}

func errNoSuitableImage() *httpx.Error {
	return httpx.BadRequest("NO_SUITABLE_IMAGE", "7TV has no image of this emote under 256 KB")
}

type sevenTV struct {
	base   string // e.g. https://7tv.io
	client *http.Client
}

func newSevenTV(base string) *sevenTV {
	if base == "" {
		base = DefaultSevenTVURL
	}
	return &sevenTV{base: strings.TrimSuffix(base, "/"), client: &http.Client{Timeout: 20 * time.Second}}
}

// gqlImage and gqlEmote are the parts of 7TV's v4 schema we read.
type gqlImage struct {
	URL        string `json:"url"`
	Mime       string `json:"mime"`
	Size       int64  `json:"size"`
	Scale      int    `json:"scale"`
	FrameCount int    `json:"frameCount"`
}

type gqlEmote struct {
	ID          string `json:"id"`
	DefaultName string `json:"defaultName"`
	Flags       struct {
		Animated bool `json:"animated"`
	} `json:"flags"`
	Images []gqlImage `json:"images"`
}

const emoteFields = `id defaultName flags { animated } images { url mime size scale frameCount }`

// query posts a GraphQL query to /v4/gql and decodes its data into out.
func (c *sevenTV) query(ctx context.Context, q string, vars map[string]any, out any) error {
	body, err := json.Marshal(map[string]any{"query": q, "variables": vars})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/v4/gql", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%w: %v", errSevenTV, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", errSevenTV, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: status %d", errSevenTV, resp.StatusCode)
	}
	var r struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxGQLBody)).Decode(&r); err != nil {
		return fmt.Errorf("%w: %v", errSevenTV, err)
	}
	if len(r.Errors) > 0 {
		return fmt.Errorf("%w: %s", errSevenTV, r.Errors[0].Message)
	}
	return json.Unmarshal(r.Data, out)
}

// search returns a page of non-NSFW emotes matching q, most used first.
func (c *sevenTV) search(ctx context.Context, q string, page int) ([]gqlEmote, int, error) {
	var r struct {
		Emotes struct {
			Search struct {
				Items     []gqlEmote `json:"items"`
				PageCount int        `json:"pageCount"`
			} `json:"search"`
		} `json:"emotes"`
	}
	err := c.query(ctx, `query($q: String, $page: Int, $perPage: Int) { emotes { search(query: $q, page: $page, perPage: $perPage,
		sort: {sortBy: TOP_ALL_TIME, order: DESCENDING}, filters: {nsfw: false}) { pageCount items { `+emoteFields+` } } } }`,
		map[string]any{"q": q, "page": page, "perPage": sevenTVPerPage}, &r)
	return r.Emotes.Search.Items, r.Emotes.Search.PageCount, err
}

// set returns an emote set with its emotes named by their alias, or nil
// when there is none. An emote in the set twice is listed once.
func (c *sevenTV) set(ctx context.Context, setID string) (*SevenTVSet, error) {
	var r struct {
		EmoteSets struct {
			EmoteSet *struct {
				ID     string `json:"id"`
				Name   string `json:"name"`
				Emotes struct {
					Items []struct {
						Alias string   `json:"alias"`
						Emote gqlEmote `json:"emote"`
					} `json:"items"`
				} `json:"emotes"`
			} `json:"emoteSet"`
		} `json:"emoteSets"`
	}
	// Sets hold at most 1000 emotes, which 7TV returns in one page.
	if err := c.query(ctx, `query($id: Id!) { emoteSets { emoteSet(id: $id) { id name emotes(page: 1, perPage: 1000) { items { alias emote { `+emoteFields+` } } } } } }`,
		map[string]any{"id": setID}, &r); err != nil {
		return nil, err
	}
	set := r.EmoteSets.EmoteSet
	if set == nil {
		return nil, nil
	}
	out := &SevenTVSet{ID: set.ID, Name: set.Name, Items: []SevenTVEmote{}}
	seen := map[string]bool{}
	for _, it := range set.Emotes.Items {
		e := it.Emote
		if seen[e.ID] {
			continue
		}
		seen[e.ID] = true
		if it.Alias != "" {
			e.DefaultName = it.Alias
		}
		if v, ok := toSevenTVEmote(e); ok {
			out.Items = append(out.Items, v)
		}
	}
	return out, nil
}

// emote looks an emote up by ID, or returns nil when there is none.
func (c *sevenTV) emote(ctx context.Context, emoteID string) (*gqlEmote, error) {
	var r struct {
		Emotes struct {
			Emote *gqlEmote `json:"emote"`
		} `json:"emotes"`
	}
	err := c.query(ctx, `query($id: Id!) { emotes { emote(id: $id) { `+emoteFields+` } } }`, map[string]any{"id": emoteID}, &r)
	return r.Emotes.Emote, err
}

// download fetches an image 7TV listed for an emote, at most MaxEmojiBytes.
func (c *sevenTV) download(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errSevenTV, err)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errSevenTV, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: image status %d", errSevenTV, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, MaxEmojiBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errSevenTV, err)
	}
	if len(data) > MaxEmojiBytes {
		return nil, errTooLarge()
	}
	return data, nil
}

// toSevenTVEmote picks the 1x WebP (animated if the emote is) as the preview;
// an emote without one (its images still processing) is left out.
func toSevenTVEmote(e gqlEmote) (SevenTVEmote, bool) {
	for _, im := range e.Images {
		if im.Mime == "image/webp" && im.Scale == 1 && (im.FrameCount > 1) == e.Flags.Animated {
			return SevenTVEmote{ID: e.ID, Name: e.DefaultName, Animated: e.Flags.Animated, PreviewURL: im.URL}, true
		}
	}
	return SevenTVEmote{}, false
}

// bestImage picks the largest image that fits as an emoji: animated if the
// emote is, WebP before GIF before PNG at the same scale.
func bestImage(e *gqlEmote) (gqlImage, bool) {
	rank := map[string]int{"image/webp": 3, "image/gif": 2, "image/png": 1}
	var best gqlImage
	for _, im := range e.Images {
		if rank[im.Mime] == 0 || im.Size <= 0 || im.Size > MaxEmojiBytes || (im.FrameCount > 1) != e.Flags.Animated {
			continue
		}
		if im.Scale > best.Scale || (im.Scale == best.Scale && rank[im.Mime] > rank[best.Mime]) {
			best = im
		}
	}
	return best, best.URL != ""
}

func (s *Service) searchSevenTV(ctx context.Context, q string, page int) (*SevenTVPage, error) {
	items, pages, err := s.sevenTV.search(ctx, q, page)
	if err != nil {
		slog.WarnContext(ctx, "expressions: 7tv search", "err", err)
		return nil, sevenTVError()
	}
	out := &SevenTVPage{Items: []SevenTVEmote{}}
	for _, e := range items {
		if v, ok := toSevenTVEmote(e); ok {
			out.Items = append(out.Items, v)
		}
	}
	if page < pages && page < sevenTVMaxPage {
		out.NextPage = page + 1
	}
	return out, nil
}

func (s *Service) sevenTVSet(ctx context.Context, setID string) (*SevenTVSet, error) {
	if !sevenTVID.MatchString(setID) {
		return nil, httpx.NotFound("emote set")
	}
	set, err := s.sevenTV.set(ctx, setID)
	if err != nil {
		slog.WarnContext(ctx, "expressions: 7tv set", "err", err)
		return nil, sevenTVError()
	}
	if set == nil {
		return nil, httpx.NotFound("emote set")
	}
	return set, nil
}

// importSevenTV looks the emote up with 7TV by its ID, downloads its best
// image that fits and adds it as a custom emoji. It never fetches a URL a
// client supplied.
func (s *Service) importSevenTV(ctx context.Context, emoteID, name string) (*Emoji, error) {
	if !sevenTVID.MatchString(emoteID) {
		return nil, httpx.NotFound("emote")
	}
	e, err := s.sevenTV.emote(ctx, emoteID)
	if err != nil {
		slog.WarnContext(ctx, "expressions: 7tv emote", "err", err)
		return nil, sevenTVError()
	}
	if e == nil {
		return nil, httpx.NotFound("emote")
	}
	im, ok := bestImage(e)
	if !ok {
		return nil, errNoSuitableImage()
	}
	data, err := s.sevenTV.download(ctx, im.URL)
	var he *httpx.Error
	if errors.As(err, &he) {
		return nil, he
	}
	if err != nil {
		slog.WarnContext(ctx, "expressions: 7tv image", "err", err)
		return nil, sevenTVError()
	}
	return s.insert(ctx, name, data)
}
