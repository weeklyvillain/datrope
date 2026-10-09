// Package voice puts users into LiveKit rooms (spec sections 2.2 and 5.3).
// Media never passes through this server: it checks permissions, issues
// LiveKit tokens, follows LiveKit webhooks, and asks LiveKit to remove,
// mute or update participants.
package voice

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/twitchtv/twirp"

	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Config says how to reach LiveKit. Voice is off when URL is empty.
type Config struct {
	URL       string // LiveKit's API as this server reaches it, e.g. http://livekit:7880
	PublicURL string // what clients connect to, e.g. wss://chat.example.com/livekit
	APIKey    string
	APISecret string
}

func (c Config) Enabled() bool { return c.URL != "" }

// TokenTTL bounds how long a join token can be used to connect. LiveKit
// refreshes the token of a connected participant by itself.
const TokenTTL = 10 * time.Minute

// issuedAttr is the participant attribute that says when its token was issued
// (Unix milliseconds), so a sign-out can tell tokens from before it.
const issuedAttr = "datrope.issued"

// More participant attributes: the auth session that joined, and the
// user's own mute and deafen flags ("1" or "0"), which a restarted server
// reads back from LiveKit.
const (
	sessionAttr  = "datrope.session"
	selfMuteAttr = "datrope.self_mute"
	selfDeafAttr = "datrope.self_deaf"
)

func flagAttr(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// selfAttrs are the attributes for a user's own mute and deafen flags.
func selfAttrs(mute, deaf bool) map[string]string {
	return map[string]string{selfMuteAttr: flagAttr(mute), selfDeafAttr: flagAttr(deaf)}
}

// Rooms are named after channel IDs, participants after user IDs.
func roomName(channelID id.ID) string { return channelID.String() }
func identity(userID id.ID) string    { return userID.String() }

// Sources lists the track sources a member may publish: audio needs SPEAK,
// camera and screen need STREAM. A server-muted member publishes no audio.
func Sources(p perms.Perms, serverMute bool) []livekit.TrackSource {
	out := []livekit.TrackSource{}
	if p.Has(perms.Speak) && !serverMute {
		out = append(out, livekit.TrackSource_MICROPHONE)
	}
	if p.Has(perms.Stream) {
		out = append(out, livekit.TrackSource_CAMERA, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO)
	}
	return out
}

// Attrs are what a join token records about the connection in its
// participant attributes, so they survive a restart of this server.
type Attrs struct {
	SessionID          id.ID // the auth session that joined (0: none)
	SelfMute, SelfDeaf bool
}

// JoinToken lets one user into one channel's room, publishing only sources.
func (c Config) JoinToken(channelID, userID id.ID, name string, sources []livekit.TrackSource, a Attrs) (string, error) {
	g := &lkauth.VideoGrant{RoomJoin: true, Room: roomName(channelID)}
	g.SetCanSubscribe(true)
	g.SetCanPublishData(false)
	g.SetCanUpdateOwnMetadata(false)
	g.SetCanPublish(len(sources) > 0)
	if len(sources) > 0 {
		g.SetCanPublishSources(sources)
	}
	attrs := selfAttrs(a.SelfMute, a.SelfDeaf)
	attrs[issuedAttr] = strconv.FormatInt(time.Now().UnixMilli(), 10)
	attrs[sessionAttr] = a.SessionID.String()
	return lkauth.NewAccessToken(c.APIKey, c.APISecret).
		SetIdentity(identity(userID)).SetName(name).SetValidFor(TokenTTL).SetVideoGrant(g).
		SetAttributes(attrs).ToJWT()
}

// Rooms calls LiveKit's RoomService. Each call carries a short-lived admin
// token limited to what the call does.
type Rooms struct {
	cfg Config
	rs  livekit.RoomService
}

func NewRooms(cfg Config) *Rooms {
	return &Rooms{cfg: cfg, rs: livekit.NewRoomServiceProtobufClient(cfg.URL, &http.Client{Timeout: 5 * time.Second})}
}

func (r *Rooms) authed(ctx context.Context, g *lkauth.VideoGrant) (context.Context, error) {
	token, err := lkauth.NewAccessToken(r.cfg.APIKey, r.cfg.APISecret).SetVideoGrant(g).SetValidFor(time.Minute).ToJWT()
	if err != nil {
		return nil, err
	}
	return twirp.WithHTTPRequestHeaders(ctx, http.Header{"Authorization": {"Bearer " + token}})
}

// notFound reports LiveKit saying the room or participant does not exist.
func notFound(err error) bool {
	var te twirp.Error
	return errors.As(err, &te) && te.Code() == twirp.NotFound
}

// Ensure creates a channel's room unless it exists. Joining calls it first,
// so an unreachable LiveKit fails the join rather than the client.
func (r *Rooms) Ensure(ctx context.Context, channelID id.ID) error {
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomCreate: true})
	if err != nil {
		return err
	}
	_, err = r.rs.CreateRoom(ctx, &livekit.CreateRoomRequest{Name: roomName(channelID), EmptyTimeout: 300, DepartureTimeout: 20})
	return err
}

// List returns the names of all open rooms.
func (r *Rooms) List(ctx context.Context) ([]string, error) {
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomList: true})
	if err != nil {
		return nil, err
	}
	res, err := r.rs.ListRooms(ctx, &livekit.ListRoomsRequest{})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(res.Rooms))
	for _, room := range res.Rooms {
		names = append(names, room.Name)
	}
	return names, nil
}

// Participants lists who is in a room; a missing room has nobody.
func (r *Rooms) Participants(ctx context.Context, room string) ([]*livekit.ParticipantInfo, error) {
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomAdmin: true, Room: room})
	if err != nil {
		return nil, err
	}
	res, err := r.rs.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if notFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return res.Participants, nil
}

// Remove disconnects a user from a channel's room. Already gone is fine.
func (r *Rooms) Remove(ctx context.Context, channelID, userID id.ID) error {
	room := roomName(channelID)
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomAdmin: true, Room: room})
	if err != nil {
		return err
	}
	_, err = r.rs.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: room, Identity: identity(userID)})
	if notFound(err) {
		return nil
	}
	return err
}

// SetSources changes what a connected user may publish. LiveKit unpublishes
// their tracks whose source is no longer allowed. Already gone is fine.
func (r *Rooms) SetSources(ctx context.Context, channelID, userID id.ID, sources []livekit.TrackSource) error {
	room := roomName(channelID)
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomAdmin: true, Room: room})
	if err != nil {
		return err
	}
	_, err = r.rs.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room: room, Identity: identity(userID),
		Permission: &livekit.ParticipantPermission{CanSubscribe: true, CanPublish: len(sources) > 0, CanPublishSources: sources},
	})
	if notFound(err) {
		return nil
	}
	return err
}

// SetAttributes changes some of a connected user's participant attributes,
// leaving the others and their permissions as they are. Already gone is fine.
func (r *Rooms) SetAttributes(ctx context.Context, channelID, userID id.ID, attrs map[string]string) error {
	room := roomName(channelID)
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomAdmin: true, Room: room})
	if err != nil {
		return err
	}
	// Without a Permission, LiveKit keeps the participant's permissions.
	_, err = r.rs.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{Room: room, Identity: identity(userID), Attributes: attrs})
	if notFound(err) {
		return nil
	}
	return err
}

// Delete closes a channel's room and disconnects everyone in it.
func (r *Rooms) Delete(ctx context.Context, channelID id.ID) error {
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomCreate: true})
	if err != nil {
		return err
	}
	_, err = r.rs.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: roomName(channelID)})
	if notFound(err) {
		return nil
	}
	return err
}
