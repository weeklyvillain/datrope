package music

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"time"

	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/livekit/server-sdk-go/v2/pkg/oggreader"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/datrope/datrope/server/internal/id"
)

// player is one channel's bot: its queue, and the track playing.
type player struct {
	s         *Service
	channelID id.ID
	botID     string

	mu       sync.Mutex
	queue    []MusicTrack
	current  *MusicTrack
	paused   bool
	played   time.Duration // of the current track, up to the last pause
	resumed  time.Time     // when it last started or resumed playing
	stopped  bool
	skipFn   context.CancelFunc // ends the current track
	wake     chan struct{}      // something was queued, or a command arrived
	resume   chan struct{}      // closed on resume; replaced on pause
	room     *lksdk.Room
	track    *lksdk.LocalTrack
	lostRoom chan struct{} // closed when LiveKit drops the bot
}

func newPlayer(s *Service, channelID id.ID) *player {
	return &player{s: s, channelID: channelID, botID: "music-" + channelID.String(),
		wake: make(chan struct{}, 1), resume: make(chan struct{}), lostRoom: make(chan struct{})}
}

func (p *player) poke() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *player) snapshot() MusicState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.s.withFlags(p.snapshotLocked())
}

func (p *player) snapshotLocked() MusicState {
	st := MusicState{ChannelID: p.channelID, Paused: p.paused, Queue: slices.Clone(p.queue)}
	if st.Queue == nil {
		st.Queue = []MusicTrack{}
	}
	if p.current != nil {
		c := *p.current
		st.Current = &c
		pos := p.played
		if !p.paused && !p.resumed.IsZero() {
			pos += time.Since(p.resumed)
		}
		st.Position = pos.Seconds()
	}
	if p.room != nil {
		st.BotID = p.botID
	}
	return st
}

func (p *player) publish() { p.s.publish(p.snapshot()) }

const maxQueue = 100

// ErrQueueFull: the queue holds maxQueue tracks.
var ErrQueueFull = errors.New("music: queue full")

// add queues a track; false once the player has stopped.
func (p *player) add(t MusicTrack) error {
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return errStopped
	}
	if len(p.queue) >= maxQueue {
		p.mu.Unlock()
		return ErrQueueFull
	}
	p.queue = append(p.queue, t)
	p.mu.Unlock()
	p.poke()
	p.publish()
	return nil
}

var errStopped = errors.New("music: player stopped")

func (p *player) setPaused(paused bool) {
	p.mu.Lock()
	if p.current == nil || p.paused == paused {
		p.mu.Unlock()
		return
	}
	p.paused = paused
	if paused {
		p.played += time.Since(p.resumed)
		p.resume = make(chan struct{})
	} else {
		p.resumed = time.Now()
		close(p.resume)
	}
	p.mu.Unlock()
	p.publish()
}

func (p *player) skip() {
	p.mu.Lock()
	fn := p.skipFn
	p.mu.Unlock()
	if fn != nil {
		fn()
	}
}

func (p *player) remove(trackID id.ID) bool {
	p.mu.Lock()
	n := len(p.queue)
	p.queue = slices.DeleteFunc(p.queue, func(t MusicTrack) bool { return t.ID == trackID })
	removed := len(p.queue) != n
	p.mu.Unlock()
	if removed {
		p.publish()
	}
	return removed
}

// stop empties the queue, ends the track and makes the bot leave.
func (p *player) stop() {
	p.mu.Lock()
	p.stopped = true
	p.queue = nil
	fn := p.skipFn
	if p.paused {
		p.paused = false
		close(p.resume)
	}
	p.mu.Unlock()
	if fn != nil {
		fn()
	}
	p.poke()
}

// next takes the first queued track and makes it current.
func (p *player) next() *MusicTrack {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.current, p.paused, p.played, p.resumed = nil, false, 0, time.Time{}
	if p.stopped || len(p.queue) == 0 {
		return nil
	}
	t := p.queue[0]
	p.queue = p.queue[1:]
	p.current = &t
	return &t
}

func (p *player) run(ctx context.Context) {
	defer p.disconnect()
	alone := time.Time{} // when the channel was last seen without people
	for {
		t := p.next()
		p.mu.Lock()
		stopped := p.stopped
		p.mu.Unlock()
		if stopped {
			return
		}
		if t == nil {
			p.publish()
			select {
			case <-ctx.Done():
				return
			case <-p.lostRoom:
				return
			case <-p.wake:
				continue
			case <-time.After(idleTimeout):
				return
			}
		}
		if p.s.humans(p.channelID) == 0 {
			if alone.IsZero() {
				alone = time.Now()
			} else if time.Since(alone) > idleTimeout {
				return
			}
		} else {
			alone = time.Time{}
		}
		if err := p.connect(); err != nil {
			logErr(ctx, "joining voice", err)
			return
		}
		logErr(ctx, "playing "+t.Title, p.play(ctx, t))
	}
}

func (p *player) connect() error {
	p.mu.Lock()
	connected := p.room != nil
	p.mu.Unlock()
	if connected {
		return nil
	}
	lk := p.s.lk
	g := &lkauth.VideoGrant{RoomJoin: true, Room: p.channelID.String()}
	g.SetCanSubscribe(false)
	g.SetCanPublish(true)
	g.SetCanPublishData(false)
	g.SetCanPublishSources([]livekit.TrackSource{livekit.TrackSource_MICROPHONE})
	token, err := lkauth.NewAccessToken(lk.APIKey, lk.APISecret).SetIdentity(p.botID).SetName("Music").
		SetValidFor(24 * time.Hour).SetVideoGrant(g).ToJWT()
	if err != nil {
		return err
	}
	lost := p.lostRoom
	var once sync.Once
	room, err := lksdk.ConnectToRoomWithToken(lk.URL, token, &lksdk.RoomCallback{
		OnDisconnected: func() { once.Do(func() { close(lost) }) },
	}, lksdk.WithAutoSubscribe(false))
	if err != nil {
		return err
	}
	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
	if err != nil {
		room.Disconnect()
		return err
	}
	if _, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "music", Source: livekit.TrackSource_MICROPHONE}); err != nil {
		room.Disconnect()
		return err
	}
	p.mu.Lock()
	p.room, p.track = room, track
	p.mu.Unlock()
	return nil
}

func (p *player) disconnect() {
	p.mu.Lock()
	room := p.room
	p.room, p.track, p.stopped = nil, nil, true
	p.mu.Unlock()
	if room != nil {
		room.Disconnect()
	}
}

// play streams one track into the room, paced in real time, until it ends,
// is skipped or the player stops.
func (p *player) play(ctx context.Context, t *MusicTrack) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	p.mu.Lock()
	p.skipFn = cancel
	track := p.track
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.skipFn = nil
		p.mu.Unlock()
	}()

	var stdin io.ReadCloser
	input := ""
	if t.blob != "" {
		f, err := p.s.blobs.OpenBlob(t.blob)
		if err != nil {
			return err
		}
		stdin = f
		defer f.Close()
	} else {
		u, err := p.s.resolver.Stream(ctx, t.URL)
		if err != nil {
			return err
		}
		input = u
	}
	cmd := ffmpegCmd(ctx, p.s.ffmpeg, input, stdin)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	defer func() { _ = cmd.Wait() }()
	reader, _, err := oggreader.NewOggReader(out)
	if err != nil {
		if ctx.Err() != nil {
			return nil // skipped or stopped while starting
		}
		return ffmpegError(err, &stderr)
	}

	p.mu.Lock()
	p.resumed = time.Now()
	p.mu.Unlock()
	p.publish()
	deadline := time.Now()
	for {
		p.mu.Lock()
		paused, resume := p.paused, p.resume
		p.mu.Unlock()
		if paused {
			select {
			case <-resume:
				deadline = time.Now()
			case <-ctx.Done():
				return nil
			}
		}
		pkt, err := reader.ReadPacket()
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return nil
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil // skipped
			}
			return ffmpegError(err, &stderr)
		}
		if bytes.HasPrefix(pkt, []byte("OpusHead")) || bytes.HasPrefix(pkt, []byte("OpusTags")) {
			continue
		}
		dur, err := oggreader.ParsePacketDuration(pkt)
		if err != nil || dur <= 0 {
			dur = 20 * time.Millisecond
		}
		if err := track.WriteSample(media.Sample{Data: pkt, Duration: dur}, nil); err != nil && !errors.Is(err, io.ErrClosedPipe) {
			return err
		}
		deadline = deadline.Add(dur)
		wait := time.Until(deadline)
		if wait < -200*time.Millisecond { // fell behind (a slow source): don't rush to catch up
			deadline = time.Now()
			continue
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
	}
}

func ffmpegError(err error, stderr *bytes.Buffer) error {
	msg := strings.TrimSpace(stderr.String())
	if len(msg) > 300 {
		msg = msg[:300]
	}
	if msg == "" {
		return err
	}
	return fmt.Errorf("%w: ffmpeg: %s", err, msg)
}
