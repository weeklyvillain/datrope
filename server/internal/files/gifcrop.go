package files

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/gif"

	"golang.org/x/image/draw"
)

// maxGIFDecodePixels caps frames × width × height of a GIF that CropGIF
// decodes, since every frame is held in memory (one byte per pixel).
const maxGIFDecodePixels = 64 << 20

var errGIFTooBig = errors.New("gif has too many frames to crop")

// CropGIF cuts crop out of every frame of a GIF and scales it to w × h,
// keeping the animation (delays and loop count).
func CropGIF(data []byte, crop image.Rectangle, w, h int) ([]byte, error) {
	frames, err := gifFrames(data)
	if err != nil {
		return nil, err
	}
	cfg, err := gif.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if frames*cfg.Width*cfg.Height > maxGIFDecodePixels {
		return nil, errGIFTooBig
	}
	g, err := gif.DecodeAll(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if !crop.In(image.Rect(0, 0, g.Config.Width, g.Config.Height)) || crop.Empty() {
		return nil, errBadImage
	}

	// Frames may cover only part of the screen and build on earlier ones, so
	// each is drawn onto a canvas (honouring its disposal) before cropping.
	canvas := image.NewRGBA(image.Rect(0, 0, g.Config.Width, g.Config.Height))
	scaled := image.NewRGBA(image.Rect(0, 0, w, h))
	out := &gif.GIF{LoopCount: g.LoopCount, Delay: g.Delay}
	var saved *image.RGBA
	for i, f := range g.Image {
		disposal := byte(0)
		if i < len(g.Disposal) {
			disposal = g.Disposal[i]
		}
		if disposal == gif.DisposalPrevious {
			saved = image.NewRGBA(canvas.Bounds())
			copy(saved.Pix, canvas.Pix)
		}
		draw.Draw(canvas, f.Bounds(), f, f.Bounds().Min, draw.Over)

		draw.CatmullRom.Scale(scaled, scaled.Bounds(), canvas, crop, draw.Src, nil)
		pal := color.Palette(append([]color.Color{}, f.Palette...))
		if !scaled.Opaque() && len(pal) < 256 && !hasTransparent(pal) {
			pal = append(pal, color.RGBA{})
		}
		frame := image.NewPaletted(scaled.Bounds(), pal)
		draw.Draw(frame, frame.Bounds(), scaled, image.Point{}, draw.Src) // nearest colour: dithering would shimmer
		out.Image = append(out.Image, frame)
		out.Disposal = append(out.Disposal, gif.DisposalBackground) // every frame is whole

		switch disposal {
		case gif.DisposalBackground:
			draw.Draw(canvas, f.Bounds(), image.Transparent, image.Point{}, draw.Src)
		case gif.DisposalPrevious:
			copy(canvas.Pix, saved.Pix)
		}
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, out); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func hasTransparent(p color.Palette) bool {
	for _, c := range p {
		if _, _, _, a := c.RGBA(); a == 0 {
			return true
		}
	}
	return false
}

// gifFrames counts a GIF's frames by walking its blocks, without decoding
// any pixels.
func gifFrames(data []byte) (int, error) {
	if len(data) < 13 || !bytes.HasPrefix(data, []byte("GIF8")) {
		return 0, errBadImage
	}
	i := 13
	if data[10]&0x80 != 0 {
		i += 3 << (data[10]&7 + 1) // global colour table
	}
	// skipSubBlocks moves i past a run of length-prefixed sub-blocks.
	skipSubBlocks := func() bool {
		for i < len(data) {
			n := int(data[i])
			i++
			if n == 0 {
				return true
			}
			i += n
		}
		return false
	}
	frames := 0
	for i < len(data) {
		switch data[i] {
		case 0x21: // extension: introducer, label, sub-blocks
			i += 2
			if !skipSubBlocks() {
				return 0, errBadImage
			}
		case 0x2C: // image descriptor (10 bytes), local colour table, LZW code size, sub-blocks
			if i+10 > len(data) {
				return 0, errBadImage
			}
			flags := data[i+9]
			i += 10
			if flags&0x80 != 0 {
				i += 3 << (flags&7 + 1)
			}
			i++ // LZW minimum code size
			if !skipSubBlocks() {
				return 0, errBadImage
			}
			frames++
		case 0x3B: // trailer
			return frames, nil
		default:
			return 0, errBadImage
		}
	}
	return 0, errBadImage
}
