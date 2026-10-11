package files_test

import (
	"bytes"
	"encoding/binary"
	"image/jpeg"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/files"
)

func TestSniff(t *testing.T) {
	for _, tc := range []struct {
		data []byte
		ct   string
		kind files.Kind
	}{
		{pngImage(2, 2, false), "image/png", files.KindPNG},
		{jpegImage(2, 2), "image/jpeg", files.KindJPEG},
		{gifImage(2, 2), "image/gif", files.KindGIF},
		{webpWithExif("x"), "image/webp", files.KindWebP},
		{[]byte("hello there"), "text/plain; charset=utf-8", ""},
		{[]byte("fLaC\x00\x00\x00\x22"), "audio/flac", ""},
		{[]byte("OggS\x00\x02\x00\x00"), "audio/ogg", ""},
		{ftyp("M4A ", "mp42"), "audio/mp4", ""},
		{ftyp("qt  ", "qt  "), "video/quicktime", ""},
		{ftyp("isom", "mp41"), "video/mp4", ""},
	} {
		ct, kind := files.Sniff(tc.data)
		require.Equal(t, tc.ct, ct)
		require.Equal(t, tc.kind, kind)
	}
}

// ftyp returns the start of an MP4-family file with these brands.
func ftyp(major, compatible string) []byte {
	b := binary.BigEndian.AppendUint32(nil, 20)
	return append(b, "ftyp"+major+"\x00\x00\x02\x00"+compatible...)
}

func TestCleanJPEGStripsLosslessly(t *testing.T) {
	orig := jpegImage(40, 20)
	dirty := withSegments(orig, exifSegment(1, "SECRET-GPS"), comSegment("SECRET-NOTE"))
	clean, err := files.Clean(files.KindJPEG, dirty)
	require.NoError(t, err)
	require.Equal(t, orig, clean, "metadata segments are removed byte-for-byte")
}

func TestCleanJPEGAppliesOrientation(t *testing.T) {
	dirty := withSegments(jpegImage(40, 20), exifSegment(6, "SECRET-GPS"))
	clean, err := files.Clean(files.KindJPEG, dirty)
	require.NoError(t, err)
	require.NotContains(t, string(clean), "SECRET-GPS")
	require.NotContains(t, string(clean), "Exif")
	img, err := jpeg.Decode(bytes.NewReader(clean))
	require.NoError(t, err)
	require.Equal(t, 20, img.Bounds().Dx(), "rotated 90 degrees: width and height swap")
	require.Equal(t, 40, img.Bounds().Dy())
}

func TestCleanPNG(t *testing.T) {
	orig := pngImage(10, 10, false)
	clean, err := files.Clean(files.KindPNG, pngWithText(orig, "Comment", "SECRET"))
	require.NoError(t, err)
	require.Equal(t, orig, clean)
}

func TestCleanWebP(t *testing.T) {
	clean, err := files.Clean(files.KindWebP, webpWithExif("SECRET"))
	require.NoError(t, err)
	require.NotContains(t, string(clean), "SECRET")
	require.NotContains(t, string(clean), "EXIF")
	require.Zero(t, clean[20]&0x08, "the VP8X EXIF flag is cleared")
	require.Equal(t, uint32(len(clean)-8), binary.LittleEndian.Uint32(clean[4:8]), "RIFF size is updated")
	w, h, err := files.Info(clean)
	require.NoError(t, err)
	require.Equal(t, 1, w)
	require.Equal(t, 1, h)
}

func TestCleanGIFUnchanged(t *testing.T) {
	g := gifImage(5, 5)
	clean, err := files.Clean(files.KindGIF, g)
	require.NoError(t, err)
	require.Equal(t, g, clean)
}

func TestCleanRejectsMalformed(t *testing.T) {
	_, err := files.Clean(files.KindJPEG, []byte{0xFF, 0xD8, 0xFF})
	require.Error(t, err)
	_, err = files.Clean(files.KindPNG, []byte("not a png"))
	require.Error(t, err)
}

func TestInfo(t *testing.T) {
	w, h, err := files.Info(pngImage(30, 12, false))
	require.NoError(t, err)
	require.Equal(t, 30, w)
	require.Equal(t, 12, h)
}
