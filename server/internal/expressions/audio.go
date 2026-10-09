package expressions

import (
	"bytes"
	"encoding/binary"
	"errors"
	"time"
)

var errNotAudio = errors.New("not a supported audio file")

// maxMeasured caps a measured length: anything longer is reported as an
// hour, which is still far over the sound limit (and never overflows).
const maxMeasured = time.Hour

// audioInfo detects WAV, Ogg (Vorbis or Opus) and MP3 files and measures
// their length from the file itself (spec: sounds ≤ 5 s). Odd files are
// rejected rather than measured.
func audioInfo(data []byte) (string, time.Duration, error) {
	switch {
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WAVE":
		d, err := wavDuration(data)
		return "audio/wav", d, err
	case len(data) >= 4 && string(data[:4]) == "OggS":
		d, err := oggDuration(data)
		return "audio/ogg", d, err
	case len(data) >= 3 && (string(data[:3]) == "ID3" || (data[0] == 0xFF && data[1]&0xE0 == 0xE0)):
		d, err := mp3Duration(data)
		return "audio/mpeg", d, err
	}
	return "", 0, errNotAudio
}

// seconds converts samples at rate to a duration, capped at maxMeasured.
func seconds(samples, rate float64) time.Duration {
	s := samples / rate
	if s > maxMeasured.Seconds() {
		return maxMeasured
	}
	return time.Duration(s * float64(time.Second))
}

// wavFormat checks a fmt chunk body: PCM or float (plain or extensible),
// whole-byte samples, and fields that agree. It returns the sample rate and
// bytes per sample frame.
func wavFormat(f []byte) (rate, blockAlign uint64, ok bool) {
	tag := binary.LittleEndian.Uint16(f[0:2])
	if tag == 0xFFFE { // extensible: the subformat GUID starts with the real tag
		if len(f) < 40 {
			return 0, 0, false
		}
		tag = binary.LittleEndian.Uint16(f[24:26])
	}
	if tag != 1 && tag != 3 {
		return 0, 0, false
	}
	channels := uint64(binary.LittleEndian.Uint16(f[2:4]))
	rate = uint64(binary.LittleEndian.Uint32(f[4:8]))
	byteRate := uint64(binary.LittleEndian.Uint32(f[8:12]))
	declaredAlign := uint64(binary.LittleEndian.Uint16(f[12:14]))
	bits := uint64(binary.LittleEndian.Uint16(f[14:16]))
	blockAlign = channels * bits / 8
	if bits%8 != 0 || rate == 0 || blockAlign == 0 || declaredAlign != blockAlign || byteRate != rate*blockAlign {
		return 0, 0, false
	}
	return rate, blockAlign, true
}

func wavDuration(data []byte) (time.Duration, error) {
	n := uint64(len(data))
	var rate, blockAlign, dataSize uint64
	seenFmt, seenData := false, false
	for i := uint64(12); i+8 <= n; {
		id := string(data[i : i+4])
		size := uint64(binary.LittleEndian.Uint32(data[i+4 : i+8]))
		body := i + 8
		remaining := n - body
		switch id {
		case "fmt ":
			if seenFmt || size < 16 || size > remaining {
				return 0, errNotAudio
			}
			var ok bool
			if rate, blockAlign, ok = wavFormat(data[body : body+size]); !ok {
				return 0, errNotAudio
			}
			seenFmt = true
		case "data":
			if !seenFmt || seenData {
				return 0, errNotAudio
			}
			size = min(size, remaining) // a truncated data chunk is measured as it is
			dataSize, seenData = size, true
		default:
			if size > remaining {
				return 0, errNotAudio
			}
		}
		i = body + size + size%2 // chunks are word-aligned; keep walking to find a second data chunk
	}
	if !seenData {
		return 0, errNotAudio
	}
	return seconds(float64(dataSize/blockAlign), float64(rate)), nil
}

// oggDuration walks every page of a single logical stream; the pages must
// cover the file exactly. The length is the largest granule position seen.
// The granule itself is still trusted: a lying one can only shorten the
// measured length of what is at most 512 KB, and clients cap playback.
func oggDuration(data []byte) (time.Duration, error) {
	var rate, preSkip float64
	var serial uint32
	maxGranule := int64(-1)
	ended := false
	for i := 0; i < len(data); {
		page := data[i:]
		if ended || len(page) < 27 || string(page[:4]) != "OggS" {
			return 0, errNotAudio
		}
		header := 27 + int(page[26])
		if len(page) < header {
			return 0, errNotAudio
		}
		body := 0
		for _, l := range page[27:header] {
			body += int(l)
		}
		if len(page)-header < body {
			return 0, errNotAudio
		}
		flags := page[5]
		if bos := flags&0x02 != 0; bos != (i == 0) {
			return 0, errNotAudio // BOS on the first page only: no chained or multiplexed streams
		}
		if i == 0 {
			serial = binary.LittleEndian.Uint32(page[14:18])
			// The first page's packet says the codec and its sample rate.
			packet := page[header : header+body]
			switch {
			case bytes.HasPrefix(packet, []byte("OpusHead")) && len(packet) >= 12:
				rate = 48000 // Opus granule positions are always at 48 kHz
				preSkip = float64(binary.LittleEndian.Uint16(packet[10:12]))
			case bytes.HasPrefix(packet, []byte("\x01vorbis")) && len(packet) >= 16:
				rate = float64(binary.LittleEndian.Uint32(packet[12:16]))
			}
			if rate == 0 {
				return 0, errNotAudio
			}
		} else if binary.LittleEndian.Uint32(page[14:18]) != serial {
			return 0, errNotAudio
		}
		ended = flags&0x04 != 0
		// -1 means no packet ends on this page.
		maxGranule = max(maxGranule, int64(binary.LittleEndian.Uint64(page[6:14])))
		i += header + body
	}
	samples := float64(maxGranule) - preSkip
	if rate == 0 || samples <= 0 {
		return 0, errNotAudio
	}
	return seconds(samples, rate), nil
}

var (
	mp3Bitrates = [2][16]int{ // kbit/s for Layer III: [MPEG-1, MPEG-2/2.5][index]
		{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0},
		{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0},
	}
	mp3Rates = [3][3]int{{44100, 48000, 32000}, {22050, 24000, 16000}, {11025, 12000, 8000}} // MPEG-1, 2, 2.5
	// mp3Versions maps the header's version bits to an mp3Rates row; 1 is reserved.
	mp3Versions = [4]int{2, -1, 1, 0}
)

type mp3Header struct {
	length  int // bytes, header included
	version int // mp3Rates row
	rate    int // Hz
	samples int
}

// mp3Frame reads a Layer III frame header; ok is false for anything else.
func mp3Frame(h []byte) (mp3Header, bool) {
	if h[0] != 0xFF || h[1]&0xE0 != 0xE0 {
		return mp3Header{}, false
	}
	v := mp3Versions[(h[1]>>3)&3]
	layer := (h[1] >> 1) & 3 // 1 = Layer III
	bitrateIdx := h[2] >> 4
	rateIdx := (h[2] >> 2) & 3
	if v < 0 || layer != 1 || bitrateIdx == 0 || bitrateIdx == 15 || rateIdx == 3 {
		return mp3Header{}, false // only Layer III, no free-format
	}
	rate := mp3Rates[v][rateIdx]
	bitrate := mp3Bitrates[min(v, 1)][bitrateIdx] * 1000
	samples, coef := 1152, 144
	if v > 0 {
		samples, coef = 576, 72
	}
	return mp3Header{length: coef*bitrate/rate + int((h[2]>>1)&1), version: v, rate: rate, samples: samples}, true
}

// mp3Duration sums the Layer III frames in the file, resyncing byte by byte
// over anything else. A frame counts only when another header (or the end)
// follows it, and every frame must share the first one's version and rate.
func mp3Duration(data []byte) (time.Duration, error) {
	end := len(data)
	if end >= 128 && string(data[end-128:end-125]) == "TAG" { // ID3v1
		end -= 128
	}
	i := 0
	if end >= 10 && string(data[:3]) == "ID3" { // skip an ID3v2 tag (syncsafe size)
		i = 10 + (int(data[6]&0x7F)<<21 | int(data[7]&0x7F)<<14 | int(data[8]&0x7F)<<7 | int(data[9]&0x7F))
	}
	var first mp3Header
	var samples float64
	frames := 0
	for i+4 <= end {
		h, ok := mp3Frame(data[i : i+4])
		next := i + h.length
		if ok && h.length >= 4 && next <= end {
			if next+4 <= end {
				_, ok = mp3Frame(data[next : next+4])
			} else {
				ok = next == end
			}
		} else {
			ok = false
		}
		if !ok {
			i++
			continue
		}
		if frames == 0 {
			first = h
		} else if h.version != first.version || h.rate != first.rate {
			return 0, errNotAudio
		}
		samples += float64(h.samples)
		frames++
		i = next
	}
	if frames == 0 {
		return 0, errNotAudio
	}
	return seconds(samples, float64(first.rate)), nil
}
