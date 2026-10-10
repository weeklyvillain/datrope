package files_test

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/files"
)

var (
	red  = color.RGBA{255, 0, 0, 255}
	blue = color.RGBA{0, 0, 255, 255}
)

// twoFrames is a 100 × 50 GIF: a red frame, then a blue frame over only its
// right half that keeps the red left half underneath.
func twoFrames(t *testing.T) []byte {
	t.Helper()
	pal := color.Palette{red, blue}
	f1 := image.NewPaletted(image.Rect(0, 0, 100, 50), pal)
	f2 := image.NewPaletted(image.Rect(50, 0, 100, 50), pal)
	for i := range f2.Pix {
		f2.Pix[i] = 1
	}
	var buf bytes.Buffer
	require.NoError(t, gif.EncodeAll(&buf, &gif.GIF{
		Image: []*image.Paletted{f1, f2}, Delay: []int{7, 9}, Disposal: []byte{gif.DisposalNone, gif.DisposalNone},
		LoopCount: 3, Config: image.Config{Width: 100, Height: 50},
	}))
	return buf.Bytes()
}

func TestCropGIF(t *testing.T) {
	data := twoFrames(t)
	out, err := files.CropGIF(data, image.Rect(30, 0, 70, 20), 20, 10)
	require.NoError(t, err)
	g, err := gif.DecodeAll(bytes.NewReader(out))
	require.NoError(t, err)
	require.Len(t, g.Image, 2) // still animated
	require.Equal(t, []int{7, 9}, g.Delay)
	require.Equal(t, 3, g.LoopCount)
	require.Equal(t, image.Rect(0, 0, 20, 10), g.Image[0].Bounds())
	rgba := func(c color.Color) color.RGBA { return color.RGBAModel.Convert(c).(color.RGBA) }
	require.Equal(t, red, rgba(g.Image[0].At(19, 5)))
	// The second frame is drawn over the first: red on the left, blue on the right.
	require.Equal(t, red, rgba(g.Image[1].At(0, 5)))
	require.Equal(t, blue, rgba(g.Image[1].At(19, 5)))

	_, err = files.CropGIF(data, image.Rect(90, 0, 110, 10), 20, 10)
	require.Error(t, err, "the crop must lie inside the image")
}

func TestCropGIFTooManyFrames(t *testing.T) {
	pal := color.Palette{red}
	g := &gif.GIF{}
	for range 300 {
		g.Image = append(g.Image, image.NewPaletted(image.Rect(0, 0, 512, 512), pal))
		g.Delay = append(g.Delay, 1)
	}
	var buf bytes.Buffer
	require.NoError(t, gif.EncodeAll(&buf, g))
	_, err := files.CropGIF(buf.Bytes(), image.Rect(0, 0, 10, 10), 10, 10)
	require.ErrorContains(t, err, "too many frames")
}

func TestCropGIFRejectsGarbage(t *testing.T) {
	_, err := files.CropGIF([]byte("GIF89a not really"), image.Rect(0, 0, 1, 1), 1, 1)
	require.Error(t, err)
	data := twoFrames(t)
	_, err = files.CropGIF(data[:len(data)-5], image.Rect(0, 0, 1, 1), 1, 1) // truncated
	require.Error(t, err)
}
