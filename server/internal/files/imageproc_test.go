package files_test

import (
	"bytes"
	"encoding/binary"
	"image/jpeg"
	"image/png"
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
	} {
		ct, kind := files.Sniff(tc.data)
		require.Equal(t, tc.ct, ct)
		require.Equal(t, tc.kind, kind)
	}
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

func TestThumbnail(t *testing.T) {
	thumb, err := files.Thumbnail(files.KindPNG, pngImage(1000, 500, false))
	require.NoError(t, err)
	img, err := jpeg.Decode(bytes.NewReader(thumb))
	require.NoError(t, err, "opaque images become JPEG thumbnails")
	require.Equal(t, 400, img.Bounds().Dx())
	require.Equal(t, 200, img.Bounds().Dy())

	thumb, err = files.Thumbnail(files.KindPNG, pngImage(500, 1000, true))
	require.NoError(t, err)
	img, err = png.Decode(bytes.NewReader(thumb))
	require.NoError(t, err, "transparent images become PNG thumbnails")
	require.Equal(t, 200, img.Bounds().Dx())
	require.Equal(t, 400, img.Bounds().Dy())

	thumb, err = files.Thumbnail(files.KindPNG, pngImage(100, 100, false))
	require.NoError(t, err)
	require.Nil(t, thumb, "small images need no thumbnail")

	thumb, err = files.Thumbnail(files.KindGIF, gifImage(1000, 1000))
	require.NoError(t, err)
	require.Nil(t, thumb, "GIFs keep their animation")
}
