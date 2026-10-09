package expressions

import (
	"bytes"
	"encoding/binary"
	"math/rand"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// wav returns a PCM WAV of the given length (8 kHz, mono, 8-bit).
func wav(d time.Duration) []byte {
	const rate = 8000
	n := int(d.Seconds() * rate)
	var b bytes.Buffer
	b.WriteString("RIFF")
	binary.Write(&b, binary.LittleEndian, uint32(36+n))
	b.WriteString("WAVEfmt ")
	binary.Write(&b, binary.LittleEndian, uint32(16))
	binary.Write(&b, binary.LittleEndian, uint16(1)) // PCM
	binary.Write(&b, binary.LittleEndian, uint16(1)) // channels
	binary.Write(&b, binary.LittleEndian, uint32(rate))
	binary.Write(&b, binary.LittleEndian, uint32(rate)) // byte rate
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint16(8))
	b.WriteString("data")
	binary.Write(&b, binary.LittleEndian, uint32(n))
	b.Write(make([]byte, n))
	return b.Bytes()
}

// mp3 returns n silent MPEG-1 Layer III frames (128 kbit/s, 44.1 kHz): 1152 samples each.
func mp3(frames int) []byte {
	header := []byte{0xFF, 0xFB, 0x90, 0x00}
	frameLen := 144 * 128000 / 44100 // 417, no padding
	var b bytes.Buffer
	b.WriteString("ID3\x03\x00\x00\x00\x00\x00\x00") // empty ID3v2 tag
	for i := 0; i < frames; i++ {
		b.Write(header)
		b.Write(make([]byte, frameLen-4))
	}
	return b.Bytes()
}

// opus returns a minimal Ogg Opus stream whose last granule position is granule (48 kHz, pre-skip 312).
func opus(granule int64) []byte {
	page := func(headerType byte, gp int64, seq uint32, body []byte) []byte {
		var b bytes.Buffer
		b.WriteString("OggS")
		b.WriteByte(0)
		b.WriteByte(headerType)
		binary.Write(&b, binary.LittleEndian, gp)
		binary.Write(&b, binary.LittleEndian, uint32(1)) // serial
		binary.Write(&b, binary.LittleEndian, seq)
		binary.Write(&b, binary.LittleEndian, uint32(0)) // CRC (not checked)
		b.WriteByte(1)
		b.WriteByte(byte(len(body)))
		b.Write(body)
		return b.Bytes()
	}
	head := append([]byte("OpusHead\x01\x01"), 0x38, 0x01, 0x80, 0xBB, 0, 0, 0, 0, 0) // pre-skip 312, 48 kHz
	return append(append(page(2, 0, 0, head), page(0, 0, 1, []byte("OpusTags"))...), page(4, granule, 2, []byte{0})...)
}

func TestAudioInfo(t *testing.T) {
	ct, d, err := audioInfo(wav(2 * time.Second))
	require.NoError(t, err)
	require.Equal(t, "audio/wav", ct)
	require.InDelta(t, 2.0, d.Seconds(), 0.01)

	ct, d, err = audioInfo(mp3(100)) // 100 × 1152 / 44100 ≈ 2.61 s
	require.NoError(t, err)
	require.Equal(t, "audio/mpeg", ct)
	require.InDelta(t, 2.61, d.Seconds(), 0.05)

	ct, d, err = audioInfo(opus(48000*3 + 312))
	require.NoError(t, err)
	require.Equal(t, "audio/ogg", ct)
	require.InDelta(t, 3.0, d.Seconds(), 0.01)

	_, _, err = audioInfo([]byte("hello, not audio"))
	require.Error(t, err)
	_, _, err = audioInfo(wav(0)[:20]) // truncated
	require.Error(t, err)
}

// TestAudioInfoNoPanic feeds random and mangled input to audioInfo: it may
// fail, but must never index out of range.
func TestAudioInfoNoPanic(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	seeds := [][]byte{wav(100 * time.Millisecond), mp3(3), opus(48000), nil}
	for i := 0; i < 1000; i++ {
		var data []byte
		if seed := seeds[i%len(seeds)]; seed != nil {
			data = append([]byte(nil), seed[:rng.Intn(len(seed)+1)]...) // truncated
			for j := rng.Intn(8); j > 0 && len(data) > 0; j-- {         // and mangled
				data[rng.Intn(len(data))] = byte(rng.Intn(256))
			}
		} else {
			data = make([]byte, rng.Intn(64))
			rng.Read(data)
		}
		require.NotPanics(t, func() { _, _, _ = audioInfo(data) }, "input %x", data)
	}
}

// mp3Frames returns n silent frames with the given header and length.
func mp3Frames(header []byte, length, n int) []byte {
	var b bytes.Buffer
	for i := 0; i < n; i++ {
		b.Write(header)
		b.Write(make([]byte, length-4))
	}
	return b.Bytes()
}

// TestAudioInfoCrafted covers files built to mismeasure: odd ones are rejected.
func TestAudioInfoCrafted(t *testing.T) {
	bad := func(data []byte) {
		t.Helper()
		_, _, err := audioInfo(data)
		require.Error(t, err)
	}
	length := func(data []byte) float64 {
		t.Helper()
		_, d, err := audioInfo(data)
		require.NoError(t, err)
		return d.Seconds()
	}
	edit := func(data []byte, f func([]byte)) []byte {
		c := append([]byte(nil), data...)
		f(c)
		return c
	}
	le16 := binary.LittleEndian.PutUint16
	le32 := binary.LittleEndian.PutUint32

	// WAV
	w := wav(time.Second)
	bad(edit(w, func(b []byte) { le32(b[28:32], 0xFFFFFFFF) })) // byte rate disagrees
	bad(edit(w, func(b []byte) { le16(b[20:22], 2) }))          // ADPCM, not PCM
	bad(edit(w, func(b []byte) { le16(b[32:34], 2) }))          // wBlockAlign disagrees
	bad(edit(w, func(b []byte) { le16(b[34:36], 12) }))         // 12-bit samples
	bad(append(append([]byte(nil), w...), "data\x04\x00\x00\x00\x00\x00\x00\x00"...))
	bad(append(append([]byte(nil), w[:36]...), append([]byte("fmt "), w[16:]...)...)) // second fmt
	list := append([]byte("LIST"), 0xF0, 0xFF, 0xFF, 0xFF)
	bad(append(append(append([]byte(nil), w[:36]...), list...), w[36:]...))                       // oversized chunk
	require.InDelta(t, 1.0, length(edit(w, func(b []byte) { le32(b[40:44], 0xFFFFFFFF) })), 0.01) // truncated data

	// MP3
	frame := []byte{0xFF, 0xFB, 0x90, 0x00} // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz: 417 bytes
	// Junk between frames does not hide the frames after it (the frame before
	// the junk has no header after it, so it is not counted).
	require.InDelta(t, 300*1152/44100.0, length(append(append(mp3(1), "junk junk junk"...), mp3(300)...)), 0.01)
	tag := append([]byte("TAG"), make([]byte, 125)...)
	require.InDelta(t, 100*1152/44100.0, length(append(mp3(100), tag...)), 0.01) // ID3v1 is not audio
	// A lying APE footer no longer hides frames.
	ape := append([]byte("APETAGEX\xD0\x07\x00\x00"), make([]byte, 20)...)
	le32(ape[12:16], 0xFFFFFF)
	require.Greater(t, length(append(mp3(300), ape...)), 5.0)
	// A different sample rate part-way through.
	bad(append(mp3(50), mp3Frames([]byte{0xFF, 0xFB, 0x94, 0x00}, 384, 50)...)) // 48 kHz
	// A fake 320 kbit/s header (1044 bytes) does not swallow the real frames after it.
	fake := append([]byte{0xFF, 0xFB, 0xE0, 0x00}, mp3Frames(frame, 417, 300)...)
	require.InDelta(t, 300*1152/44100.0, length(fake), 0.01)

	// Ogg
	o := opus(48000*10 + 312)
	bad(append(append([]byte(nil), o...), "OggS\x00\x04\x01\x00\x00\x00\x00\x00\x00\x00"...)) // stray "OggS"
	bad(append(append([]byte(nil), o...), "trailing"...))                                     // bytes no page covers
	bad(append(append([]byte(nil), o...), o...))                                              // chained: a page after EOS
	bad(edit(o, func(b []byte) { le32(b[47+14:47+18], 2) }))                                  // a second serial
	bad(edit(o, func(b []byte) { b[47+5] |= 0x02 }))                                          // BOS on a later page
	bad(edit(o, func(b []byte) { b[5] = 0 }))                                                 // no BOS on the first
	// The length is the largest granule, not the last page's.
	shorter := edit(opus(1000), func(b []byte) { binary.LittleEndian.PutUint64(b[47+6:47+14], 48000*10+312) })
	require.InDelta(t, 10.0, length(shorter), 0.01)

	// Overflowing lengths are reported as too long, not as errors.
	_, d, err := audioInfo(opus(1 << 62))
	require.NoError(t, err)
	require.Equal(t, maxMeasured, d)
}
