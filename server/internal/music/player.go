package music

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
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

// Repeat modes.
const (
	RepeatOff = "off"
	RepeatAll = "all" // a finished track goes back to the end of the queue
	RepeatOne = "one" // the current track plays again until skipped
)

// player is one channel's bot: its queue, and the track playing.
type player struct {
	s         *Service
	channelID id.ID
	botID     string

	mu       sync.Mutex
	queue    []MusicTrack
	current  *MusicTrack
	ended    *ended // how the last track ended, for repeat
	repeat   string
	paused   bool
	played   time.Duration // of the current track, up to the last pause
	resumed  time.Time     // when it last started or resumed playing
	stopped  bool
	skipFn   context.CancelFunc // ends the current track
	wake     chan struct{}      // something was queued, or a command arrived
	resume   chan struct{}      // closed on resume; replaced on pause
	room     *lksdk.Room
	track    *lksdk.LocalTrack
	lostRoom chan struct{}         // closed when LiveKit drops the bot
	streams  map[string]prefetched // stream URLs found ahead of time, by page URL
}

// ended is the track that last finished and whether it played to its end.
type ended struct {
	track   MusicTrack
	natural bool // not skipped, and no error
}

type prefetched struct {
	url string
	at  time.Time
}

// prefetchAhead is how long before a track's end the next one's stream is
// looked up; prefetchTTL is how long that lookup stays usable (stream URLs expire).
const (
	prefetchAhead = 30 * time.Second
	prefetchTTL   = 5 * time.Minute
)

func newPlayer(s *Service, channelID id.ID) *player {
	return &player{s: s, channelID: channelID, botID: "music-" + channelID.String(), repeat: RepeatOff,
		wake: make(chan struct{}, 1), resume: make(chan struct{}), lostRoom: make(chan struct{}), streams: map[string]prefetched{}}
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
	st := MusicState{ChannelID: p.channelID, Paused: p.paused, Queue: slices.Clone(p.queue), Repeat: p.repeat}
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

const maxQueue = 500

// ErrQueueFull: the queue holds maxQueue tracks.
var ErrQueueFull = errors.New("music: queue full")

// add queues tracks, as many as fit, after clearing the queue when replace is
// set. It returns how many were queued: ErrQueueFull when none fit.
func (p *player) add(tracks []MusicTrack, replace bool) (int, error) {
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return 0, errStopped
	}
	if replace {
		p.queue = nil
	}
	n := min(len(tracks), maxQueue-len(p.queue))
	if n <= 0 && len(tracks) > 0 {
		p.mu.Unlock()
		return 0, ErrQueueFull
	}
	p.queue = append(p.queue, tracks[:n]...)
	p.mu.Unlock()
	p.poke()
	p.publish()
	return n, nil
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

func (p *player) setRepeat(mode string) {
	p.mu.Lock()
	p.repeat = mode
	p.mu.Unlock()
	p.publish()
}

// shuffle puts the queue in a random order, once.
func (p *player) shuffle() {
	p.mu.Lock()
	shuffleTracks(p.queue)
	p.mu.Unlock()
	p.publish()
}

func shuffleTracks(ts []MusicTrack) {
	rand.Shuffle(len(ts), func(i, j int) { ts[i], ts[j] = ts[j], ts[i] })
}

// clear empties the queue; the current track plays on.
func (p *player) clear() {
	p.mu.Lock()
	p.queue = nil
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

// next picks what plays now, by the repeat mode and how the last track ended,
// and makes it current.
func (p *player) next() *MusicTrack {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.current, p.paused, p.played, p.resumed = nil, false, 0, time.Time{}
	last := p.ended
	p.ended = nil
	if p.stopped {
		return nil
	}
	if last != nil {
		switch {
		case p.repeat == RepeatOne && last.natural:
			t := last.track
			p.current = &t
			return &t
		case p.repeat == RepeatAll && last.natural && len(p.queue) < maxQueue:
			p.queue = append(p.queue, last.track)
		}
	}
	if len(p.queue) == 0 {
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
		started := time.Now()
		natural, err := p.play(ctx, t)
		logErr(ctx, "playing "+t.Title, err)
		// A track that ends at once (broken, or empty) never repeats: no tight loop.
		natural = natural && err == nil && time.Since(started) > time.Second
		p.mu.Lock()
		p.ended = &ended{track: *t, natural: natural}
		p.mu.Unlock()
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

// find resolves a search track (Spotify) to a link the first time it comes up,
// and records the link on the queued or current track.
func (p *player) find(ctx context.Context, t *MusicTrack) error {
	if t.URL != "" || t.search == "" {
		return nil
	}
	if p.s.resolver == nil {
		return errors.New("no yt-dlp to search with")
	}
	r, err := p.s.resolver.Resolve(ctx, t.search)
	if err != nil {
		return err
	}
	dur := t.Duration
	if dur == 0 {
		dur = r.Duration
	}
	// Under the lock: t may be p.current itself, which snapshots read.
	p.mu.Lock()
	t.URL, t.Duration, t.live = r.URL, dur, r.Live
	for i := range p.queue {
		if p.queue[i].ID == t.ID {
			p.queue[i].URL, p.queue[i].Duration, p.queue[i].live = r.URL, dur, r.Live
		}
	}
	if p.current != nil && p.current.ID == t.ID {
		p.current.URL, p.current.Duration, p.current.live = r.URL, dur, r.Live
	}
	p.mu.Unlock()
	return nil
}

// prefetch looks up the next queued link's stream while this track ends, so
// it starts without waiting for yt-dlp.
func (p *player) prefetch(ctx context.Context) {
	p.mu.Lock()
	if len(p.queue) == 0 || p.repeat == RepeatOne {
		p.mu.Unlock()
		return
	}
	next := p.queue[0]
	p.mu.Unlock()
	if next.blob != "" || p.s.resolver == nil {
		return
	}
	if err := p.find(ctx, &next); err != nil || next.URL == "" {
		return
	}
	if p.s.cache != nil && cacheable(&next) && p.s.cache.has(next.URL) {
		return
	}
	u, err := p.s.resolver.Stream(ctx, next.URL)
	if err != nil {
		return
	}
	p.mu.Lock()
	p.streams = map[string]prefetched{next.URL: {u, time.Now()}} // only ever the next one
	p.mu.Unlock()
}

// stream returns a page's media URL, prefetched when possible.
func (p *player) stream(ctx context.Context, pageURL string) (string, error) {
	p.mu.Lock()
	pre, ok := p.streams[pageURL]
	delete(p.streams, pageURL)
	p.mu.Unlock()
	if ok && time.Since(pre.at) < prefetchTTL {
		return pre.url, nil
	}
	return p.s.resolver.Stream(ctx, pageURL)
}

// source opens a track as Ogg Opus: an Opus upload or a cached link directly,
// anything else through ffmpeg (teed into the cache when it may be kept).
// done(natural) releases it; a natural end keeps the cache entry.
func (p *player) source(ctx context.Context, t *MusicTrack) (r io.Reader, done func(natural bool), stderr *bytes.Buffer, err error) {
	stderr = &bytes.Buffer{}
	if t.blob != "" && t.opus {
		f, err := p.s.blobs.OpenBlob(t.blob)
		if err != nil {
			return nil, nil, nil, err
		}
		return f, func(bool) { f.Close() }, stderr, nil
	}
	if t.blob == "" {
		if err := p.find(ctx, t); err != nil {
			return nil, nil, nil, err
		}
		if p.s.cache != nil && cacheable(t) {
			if f, ok := p.s.cache.open(t.URL); ok {
				return f, func(bool) { f.Close() }, stderr, nil
			}
		}
	}
	var stdin io.ReadCloser
	input := ""
	if t.blob != "" {
		f, err := p.s.blobs.OpenBlob(t.blob)
		if err != nil {
			return nil, nil, nil, err
		}
		stdin = f
	} else {
		u, err := p.stream(ctx, t.URL)
		if err != nil {
			return nil, nil, nil, err
		}
		input = u
	}
	cmd := ffmpegCmd(ctx, p.s.ffmpeg, input, stdin)
	cmd.Stderr = stderr
	out, err := cmd.StdoutPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		if stdin != nil {
			stdin.Close()
		}
		return nil, nil, nil, err
	}
	var entry *cacheEntry
	r = out
	if t.blob == "" && p.s.cache != nil && cacheable(t) {
		if entry = p.s.cache.create(t.URL); entry != nil {
			r = io.TeeReader(out, entry)
		}
	}
	return r, func(natural bool) {
		if !natural {
			_ = cmd.Process.Kill() // skipped or failed: don't wait for the rest of the stream
		}
		_ = cmd.Wait()
		if stdin != nil {
			stdin.Close()
		}
		if entry != nil {
			if natural && cmd.ProcessState != nil && cmd.ProcessState.Success() {
				entry.commit()
			} else {
				entry.abort()
			}
		}
	}, stderr, nil
}

// play streams one track into the room, paced in real time, until it ends,
// is skipped or the player stops. natural reports that it played to its end.
func (p *player) play(ctx context.Context, t *MusicTrack) (natural bool, err error) {
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

	in, done, stderr, err := p.source(ctx, t)
	if err != nil {
		if ctx.Err() != nil {
			return false, nil // skipped or stopped while starting
		}
		return false, err
	}
	defer func() { done(natural) }()
	reader, _, err := oggreader.NewOggReader(in)
	if err != nil {
		if ctx.Err() != nil {
			return false, nil
		}
		return false, ffmpegError(err, stderr)
	}

	p.mu.Lock()
	p.resumed = time.Now()
	p.mu.Unlock()
	p.publish()
	deadline := time.Now()
	var sent time.Duration
	prefetching := false
	for {
		p.mu.Lock()
		paused, resume := p.paused, p.resume
		p.mu.Unlock()
		if paused {
			select {
			case <-resume:
				deadline = time.Now()
			case <-ctx.Done():
				return false, nil
			}
		}
		pkt, err := reader.ReadPacket()
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return ctx.Err() == nil, nil
		}
		if err != nil {
			if ctx.Err() != nil {
				return false, nil // skipped
			}
			return false, ffmpegError(err, stderr)
		}
		if bytes.HasPrefix(pkt, []byte("OpusHead")) || bytes.HasPrefix(pkt, []byte("OpusTags")) {
			continue
		}
		dur, err := oggreader.ParsePacketDuration(pkt)
		if err != nil || dur <= 0 {
			dur = 20 * time.Millisecond
		}
		if err := track.WriteSample(media.Sample{Data: pkt, Duration: dur}, nil); err != nil && !errors.Is(err, io.ErrClosedPipe) {
			return false, err
		}
		sent += dur
		if !prefetching && t.Duration > 0 && sent >= time.Duration(t.Duration)*time.Second-prefetchAhead {
			prefetching = true
			go p.prefetch(p.s.ctx)
		}
		deadline = deadline.Add(dur)
		wait := time.Until(deadline)
		if wait < -200*time.Millisecond { // fell behind (a slow source): don't rush to catch up
			deadline = time.Now()
			continue
		}
		select {
		case <-ctx.Done():
			return false, nil
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
