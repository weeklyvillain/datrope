package files_test

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/files"
)

func jseg(marker byte, payload []byte) []byte {
	n := len(payload) + 2
	return append([]byte{0xFF, marker, byte(n >> 8), byte(n)}, payload...)
}

// exifSegmentBE is the big-endian (MM) variant of exifSegment, orientation only.
func exifSegmentBE(orientation uint16) []byte {
	var t bytes.Buffer
	t.WriteString("MM\x00*")
	_ = binary.Write(&t, binary.BigEndian, uint32(8))
	_ = binary.Write(&t, binary.BigEndian, uint16(1))
	_ = binary.Write(&t, binary.BigEndian, uint16(0x0112))
	_ = binary.Write(&t, binary.BigEndian, uint16(3))
	_ = binary.Write(&t, binary.BigEndian, uint32(1))
	_ = binary.Write(&t, binary.BigEndian, orientation)
	_ = binary.Write(&t, binary.BigEndian, uint16(0))
	_ = binary.Write(&t, binary.BigEndian, uint32(0))
	return jseg(0xE1, append([]byte("Exif\x00\x00"), t.Bytes()...))
}

func pngWithChunk(p []byte, typ string, data []byte) []byte {
	chunk := binary.BigEndian.AppendUint32(nil, uint32(len(data)))
	chunk = append(chunk, typ...)
	chunk = append(chunk, data...)
	chunk = binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(chunk[4:]))
	iend := len(p) - 12
	out := append([]byte{}, p[:iend]...)
	out = append(out, chunk...)
	return append(out, p[iend:]...)
}

var gridColors = [6]color.RGBA{
	{255, 0, 0, 255}, {0, 255, 0, 255},
	{0, 0, 255, 255}, {255, 255, 0, 255},
	{0, 255, 255, 255}, {255, 0, 255, 255},
}

// gridJPEG is 2 columns x 3 rows of solid 16px cells, one colour each.
func gridJPEG() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 32, 48))
	for y := 0; y < 48; y++ {
		for x := 0; x < 32; x++ {
			img.Set(x, y, gridColors[y/16*2+x/16])
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

func near(t *testing.T, want color.RGBA, got color.Color, msg string) {
	t.Helper()
	r, g, b, _ := got.RGBA()
	for _, d := range [3]int{int(r>>8) - int(want.R), int(g>>8) - int(want.G), int(b>>8) - int(want.B)} {
		require.InDelta(t, 0, d, 60, msg)
	}
}

func TestCleanJPEGOrientationMapsPixels(t *testing.T) {
	const W, H = 2, 3 // source cells
	for _, be := range []bool{false, true} {
		for o := 1; o <= 8; o++ {
			exif := exifSegment(uint16(o), "x")
			if be {
				exif = exifSegmentBE(uint16(o))
			}
			clean, err := files.Clean(files.KindJPEG, withSegments(gridJPEG(), exif))
			require.NoError(t, err)
			img, err := jpeg.Decode(bytes.NewReader(clean))
			require.NoError(t, err)
			wantW, wantH := 32, 48
			if o >= 5 {
				wantW, wantH = 48, 32
			}
			require.Equal(t, wantW, img.Bounds().Dx(), "o=%d", o)
			require.Equal(t, wantH, img.Bounds().Dy(), "o=%d", o)
			for cy := 0; cy < H; cy++ {
				for cx := 0; cx < W; cx++ {
					dx, dy := cx, cy
					switch o { // EXIF spec: where each source cell ends up
					case 2:
						dx = W - 1 - cx
					case 3:
						dx, dy = W-1-cx, H-1-cy
					case 4:
						dy = H - 1 - cy
					case 5:
						dx, dy = cy, cx
					case 6:
						dx, dy = H-1-cy, cx
					case 7:
						dx, dy = H-1-cy, W-1-cx
					case 8:
						dx, dy = cy, W-1-cx
					}
					near(t, gridColors[cy*2+cx], img.At(dx*16+8, dy*16+8), "orientation case")
				}
			}
		}
	}
}

func TestCleanJPEGRemovesAndKeepsSegments(t *testing.T) {
	orig := jpegImage(40, 20)
	xmp := jseg(0xE1, []byte("http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta>SECRET</x:xmpmeta>"))
	for name, seg := range map[string][]byte{
		"xmp":   xmp,
		"app13": jseg(0xED, []byte("Photoshop 3.0\x00SECRET")),
		"app3":  jseg(0xE3, []byte("Meta\x00\x00SECRET")),
		"mpf":   jseg(0xE2, []byte("MPF\x00SECRET")),
		"app12": jseg(0xEC, []byte("Ducky SECRET")),
		"com":   comSegment("SECRET"),
	} {
		clean, err := files.Clean(files.KindJPEG, withSegments(orig, seg))
		require.NoError(t, err, name)
		require.Equal(t, orig, clean, name)
	}

	second := withSegments(jpegImage(8, 8), exifSegment(1, "SECRET-GPS"))
	clean, err := files.Clean(files.KindJPEG, append(append(append([]byte{}, orig...), second...), "trailing SECRET"...))
	require.NoError(t, err)
	require.Equal(t, orig, clean, "everything after EOI is dropped")

	icc := jseg(0xE2, append([]byte("ICC_PROFILE\x00\x01\x01"), bytes.Repeat([]byte{7}, 20)...))
	withICC := withSegments(orig, icc)
	clean, err = files.Clean(files.KindJPEG, withICC)
	require.NoError(t, err)
	require.Equal(t, withICC, clean, "ICC profile kept")

	clean, err = files.Clean(files.KindJPEG, withSegments(orig, icc, exifSegment(6, "SECRET")))
	require.NoError(t, err)
	require.Contains(t, string(clean), "ICC_PROFILE", "ICC survives the orientation re-encode")
	require.NotContains(t, string(clean), "SECRET")
	img, err := jpeg.Decode(bytes.NewReader(clean))
	require.NoError(t, err)
	require.Equal(t, 20, img.Bounds().Dx())
}

func TestCleanPNGRemovesChunks(t *testing.T) {
	orig := pngImage(10, 10, false)
	for _, tc := range []struct {
		typ  string
		data []byte
	}{
		{"zTXt", []byte("Comment\x00\x00SECRET")},
		{"iTXt", []byte("Comment\x00\x00\x00\x00\x00SECRET")},
		{"eXIf", []byte("MM\x00*SECRET")},
		{"tIME", []byte{7, 0xE9, 1, 2, 3, 4, 5}},
	} {
		clean, err := files.Clean(files.KindPNG, pngWithChunk(orig, tc.typ, tc.data))
		require.NoError(t, err, tc.typ)
		require.Equal(t, orig, clean, tc.typ)
	}
}

// webpWith builds a VP8X WebP from the tiny lossless image plus extra chunks.
func webpWith(flags byte, chunks ...[]byte) []byte {
	base, err := base64.StdEncoding.DecodeString(tinyWebP)
	if err != nil {
		panic(err)
	}
	vp8x := append([]byte("VP8X"), 10, 0, 0, 0, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0)
	body := append([]byte("WEBP"), vp8x...)
	body = append(body, base[12:]...)
	for _, c := range chunks {
		body = append(body, c...)
	}
	out := binary.LittleEndian.AppendUint32([]byte("RIFF"), uint32(len(body)))
	return append(out, body...)
}

func riffChunk(typ string, data []byte) []byte {
	c := binary.LittleEndian.AppendUint32([]byte(typ), uint32(len(data)))
	c = append(c, data...)
	if len(data)%2 == 1 {
		c = append(c, 0)
	}
	return c
}

func TestCleanWebPChunks(t *testing.T) {
	for name, dirty := range map[string][]byte{
		"xmp":     webpWith(0x04, riffChunk("XMP ", []byte("<x>SECRET</x>"))),
		"xmp-odd": webpWith(0x04, riffChunk("XMP ", []byte("SECRET!"))),
		"exif":    webpWith(0x08, riffChunk("EXIF", []byte("Exif\x00\x00SECRET"))),
		"both":    webpWith(0x0C, riffChunk("EXIF", []byte("Exif\x00\x00SECRET")), riffChunk("XMP ", []byte("SECRET"))),
		"odd":     webpWithExif("ODD"),
	} {
		clean, err := files.Clean(files.KindWebP, dirty)
		require.NoError(t, err, name)
		require.NotContains(t, string(clean), "SECRET", name)
		require.NotContains(t, string(clean), "EXIF", name)
		require.NotContains(t, string(clean), "XMP ", name)
		require.Zero(t, clean[20]&0x0C, name)
		require.Equal(t, uint32(len(clean)-8), binary.LittleEndian.Uint32(clean[4:8]), name)
		w, h, err := files.Info(clean)
		require.NoError(t, err, name)
		require.Equal(t, [2]int{1, 1}, [2]int{w, h}, name)
	}

	// An odd-length final chunk whose pad byte is missing is tolerated.
	dirty := webpWith(0x08, riffChunk("EXIF", []byte("ODD")))
	dirty = dirty[:len(dirty)-1]
	binary.LittleEndian.PutUint32(dirty[4:], uint32(len(dirty)-8))
	clean, err := files.Clean(files.KindWebP, dirty)
	require.NoError(t, err)
	require.NotContains(t, string(clean), "ODD")

	// A kept chunk with odd length keeps its padding.
	odd := riffChunk("ABCD", []byte("abc"))
	clean, err = files.Clean(files.KindWebP, webpWith(0, odd, riffChunk("EXIF", []byte("zz"))))
	require.NoError(t, err)
	require.Contains(t, string(clean), string(odd))
	require.Equal(t, uint32(len(clean)-8), binary.LittleEndian.Uint32(clean[4:8]))
}

func TestThumbnailRejectsDecompressionBomb(t *testing.T) {
	p := pngImage(1, 1, false)
	binary.BigEndian.PutUint32(p[16:], 20000)
	binary.BigEndian.PutUint32(p[20:], 20000)
	binary.BigEndian.PutUint32(p[29:], crc32.ChecksumIEEE(p[12:29]))
	w, h, err := files.Info(p)
	require.NoError(t, err)
	require.Equal(t, [2]int{20000, 20000}, [2]int{w, h})
	_, err = files.Thumbnail(files.KindPNG, p)
	require.ErrorContains(t, err, "too large")
}

func TestHostileInputsDoNotPanic(t *testing.T) {
	inputs := map[files.Kind][]byte{
		files.KindJPEG: withSegments(jpegImage(16, 16), exifSegment(6, "SECRET"), comSegment("x")),
		files.KindPNG:  pngWithText(pngImage(8, 8, false), "k", "v"),
		files.KindWebP: webpWithExif("SECRET"),
		files.KindGIF:  gifImage(4, 4),
	}
	for kind, data := range inputs {
		for n := 0; n <= len(data); n++ {
			require.NotPanics(t, func() {
				_, _ = files.Clean(kind, data[:n])
				_, _, _ = files.Info(data[:n])
				_, _ = files.Thumbnail(kind, data[:n])
			}, "%s truncated to %d", kind, n)
		}
	}

	// Truncations that cut through a header or segment are errors.
	dirty := inputs[files.KindJPEG]
	for _, n := range []int{0, 1, 2, 3, 5, 10} {
		_, err := files.Clean(files.KindJPEG, dirty[:n])
		require.Error(t, err, "jpeg %d", n)
	}
	for _, n := range []int{0, 7, 12, 20, len(inputs[files.KindPNG]) - 5} {
		_, err := files.Clean(files.KindPNG, inputs[files.KindPNG][:n])
		require.Error(t, err, "png %d", n)
	}
	for _, n := range []int{0, 11, 14, 25, 40} {
		_, err := files.Clean(files.KindWebP, inputs[files.KindWebP][:n])
		require.Error(t, err, "webp %d", n)
	}

	// Hostile EXIF: wild IFD offset and entry count must not panic or loop.
	bad := jseg(0xE1, append([]byte("Exif\x00\x00II*\x00"), 0xFF, 0xFF, 0xFF, 0xFF, 1, 0))
	require.NotPanics(t, func() { _, _ = files.Clean(files.KindJPEG, withSegments(jpegImage(8, 8), bad)) })
	bad = jseg(0xE1, append([]byte("Exif\x00\x00MM\x00*\x00\x00\x00\x08"), 0xFF, 0xFF))
	require.NotPanics(t, func() { _, _ = files.Clean(files.KindJPEG, withSegments(jpegImage(8, 8), bad)) })
}
