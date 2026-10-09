package files

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	_ "image/gif" // registers the GIF decoder
	"image/jpeg"
	"image/png"
	"net/http"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // registers the WebP decoder
)

// Kind is a supported image format, or "" for any other file.
type Kind string

const (
	KindJPEG Kind = "jpeg"
	KindPNG  Kind = "png"
	KindWebP Kind = "webp"
	KindGIF  Kind = "gif"
)

const (
	ThumbMax        = 400         // thumbnails fit in ThumbMax x ThumbMax
	MaxDecodePixels = 40_000_000  // never fully decode larger images
	maxGIFPixels    = 4096 * 4096 // larger GIFs are not shown in messages
)

var errBadImage = errors.New("malformed image")

// Sniff detects a file's type from its first bytes (up to 512).
func Sniff(head []byte) (contentType string, kind Kind) {
	ct := http.DetectContentType(head)
	switch ct {
	case "image/jpeg":
		return ct, KindJPEG
	case "image/png":
		return ct, KindPNG
	case "image/webp":
		return ct, KindWebP
	case "image/gif":
		return ct, KindGIF
	}
	return ct, ""
}

// Clean removes metadata (EXIF, XMP, text chunks, comments) from an image.
// A JPEG whose EXIF says it is rotated is re-encoded upright first, since
// the rotation would otherwise be lost with the metadata.
func Clean(kind Kind, data []byte) ([]byte, error) {
	switch kind {
	case KindJPEG:
		return cleanJPEG(data)
	case KindPNG:
		return cleanPNG(data)
	case KindWebP:
		return cleanWebP(data)
	case KindGIF:
		return data, nil // GIF has no EXIF
	}
	return nil, fmt.Errorf("not a supported image")
}

var iccPrefix = []byte("ICC_PROFILE\x00")

// cleanJPEG keeps only what is needed to decode and colour-manage the image:
// APP0, APP14, ICC profiles (APP2) and the structural segments. Every other
// APPn (EXIF, XMP, MPF, IPTC, ...) and COM is dropped, and anything after the
// first EOI (e.g. secondary MPF images) is discarded.
func cleanJPEG(data []byte) ([]byte, error) {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return nil, errBadImage
	}
	out := make([]byte, 0, len(data))
	out = append(out, 0xFF, 0xD8)
	var icc []byte // ICC segments, kept for the re-encode path
	orientation := 1
	for i := 2; ; {
		if i+2 > len(data) || data[i] != 0xFF {
			return nil, errBadImage
		}
		marker := data[i+1]
		if marker == 0xFF { // fill byte
			i++
			continue
		}
		if marker == 0xD9 { // EOI before any scan
			out = append(out, 0xFF, 0xD9)
			break
		}
		if marker == 0x01 || marker >= 0xD0 && marker <= 0xD7 { // markers without a length
			out = append(out, data[i:i+2]...)
			i += 2
			continue
		}
		if i+4 > len(data) {
			return nil, errBadImage
		}
		n := int(data[i+2])<<8 | int(data[i+3])
		if n < 2 || i+2+n > len(data) {
			return nil, errBadImage
		}
		seg := data[i : i+2+n]
		if marker == 0xDA { // start of scan: copy through the first EOI
			out = append(out, seg...)
			rest := data[i+2+n:]
			if k := bytes.Index(rest, []byte{0xFF, 0xD9}); k >= 0 {
				rest = rest[:k+2]
			}
			out = append(out, rest...)
			break
		}
		switch {
		case marker == 0xE1:
			if o, ok := exifOrientation(seg[4:]); ok {
				orientation = o
			}
		case marker == 0xE2 && bytes.HasPrefix(seg[4:], iccPrefix):
			icc = append(icc, seg...)
			out = append(out, seg...)
		case marker == 0xE0 || marker == 0xEE:
			out = append(out, seg...)
		case marker > 0xE0 && marker <= 0xEF, marker == 0xFE:
			// other APPn, COM: dropped
		default:
			out = append(out, seg...)
		}
		i += 2 + n
	}
	if orientation == 1 {
		return out, nil
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		return nil, err
	}
	if cfg.Width*cfg.Height > MaxDecodePixels {
		return out, nil // too big to rotate safely; keep it stripped but sideways
	}
	img, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, orient(img, orientation), &jpeg.Options{Quality: 90}); err != nil {
		return nil, err
	}
	enc := buf.Bytes()
	if len(icc) == 0 {
		return enc, nil
	}
	at := 2 // after SOI, and after APP0 if the encoder wrote one
	if len(enc) >= 6 && enc[2] == 0xFF && enc[3] == 0xE0 {
		at = 4 + (int(enc[4])<<8 | int(enc[5]))
	}
	res := append([]byte{}, enc[:at]...)
	res = append(res, icc...)
	return append(res, enc[at:]...), nil
}

// exifOrientation reads the Orientation tag (1-8) from an APP1 payload.
func exifOrientation(p []byte) (int, bool) {
	if !bytes.HasPrefix(p, []byte("Exif\x00\x00")) {
		return 0, false
	}
	t := p[6:]
	if len(t) < 8 {
		return 0, false
	}
	var bo binary.ByteOrder
	switch string(t[:4]) {
	case "II*\x00":
		bo = binary.LittleEndian
	case "MM\x00*":
		bo = binary.BigEndian
	default:
		return 0, false
	}
	off := int(bo.Uint32(t[4:8]))
	if off < 8 || off+2 > len(t) {
		return 0, false
	}
	n := int(bo.Uint16(t[off:]))
	for k := 0; k < n; k++ {
		e := off + 2 + 12*k
		if e+12 > len(t) {
			return 0, false
		}
		if bo.Uint16(t[e:]) == 0x0112 {
			v := int(bo.Uint16(t[e+8:]))
			return v, v >= 1 && v <= 8
		}
	}
	return 0, false
}

// orient applies an EXIF orientation (2-8) to an image.
func orient(src image.Image, o int) image.Image {
	if o < 2 || o > 8 {
		return src
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch o {
			case 2: // mirrored
				dx, dy = w-1-x, y
			case 3: // rotated 180
				dx, dy = w-1-x, h-1-y
			case 4: // mirrored vertically
				dx, dy = x, h-1-y
			case 5: // transposed
				dx, dy = y, x
			case 6: // rotated 90 clockwise
				dx, dy = h-1-y, x
			case 7: // transversed
				dx, dy = h-1-y, w-1-x
			case 8: // rotated 90 counter-clockwise
				dx, dy = y, w-1-x
			}
			dst.Set(dx, dy, src.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return dst
}

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

func cleanPNG(data []byte) ([]byte, error) {
	if !bytes.HasPrefix(data, pngSignature) {
		return nil, errBadImage
	}
	out := append([]byte{}, pngSignature...)
	for i := len(pngSignature); i < len(data); {
		if i+12 > len(data) {
			return nil, errBadImage
		}
		end := i + 12 + int(binary.BigEndian.Uint32(data[i:]))
		if end > len(data) {
			return nil, errBadImage
		}
		typ := string(data[i+4 : i+8])
		switch typ {
		case "eXIf", "tEXt", "zTXt", "iTXt", "tIME":
		default:
			out = append(out, data[i:end]...)
		}
		i = end
		if typ == "IEND" {
			break
		}
	}
	return out, nil
}

func cleanWebP(data []byte) ([]byte, error) {
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return nil, errBadImage
	}
	out := append([]byte{}, data[:12]...)
	for i := 12; i < len(data); {
		if i+8 > len(data) {
			return nil, errBadImage
		}
		n := int(binary.LittleEndian.Uint32(data[i+4:]))
		end := i + 8 + n + n%2
		if end == len(data)+1 {
			end = len(data) // tolerate a missing final pad byte
		}
		if end > len(data) {
			return nil, errBadImage
		}
		switch string(data[i : i+4]) {
		case "EXIF", "XMP ":
		case "VP8X":
			chunk := append([]byte{}, data[i:end]...)
			if len(chunk) > 8 {
				chunk[8] &^= 0x08 | 0x04 // clear the EXIF and XMP flags
			}
			out = append(out, chunk...)
		default:
			out = append(out, data[i:end]...)
		}
		i = end
	}
	binary.LittleEndian.PutUint32(out[4:], uint32(len(out)-8))
	return out, nil
}

// Info returns an image's dimensions without decoding its pixels.
func Info(data []byte) (width, height int, err error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	return cfg.Width, cfg.Height, err
}

// showable reports whether clients may display an image in a message. Larger
// ones are served as downloads, since every viewer's browser would decode
// the original (they get no thumbnail).
func showable(kind Kind, w, h int) bool {
	if kind == KindGIF {
		return w*h <= maxGIFPixels
	}
	return w*h <= MaxDecodePixels
}

// Thumbnail returns a copy that fits in ThumbMax x ThumbMax, or nil when the
// image is already that small or is a GIF (kept as-is so it stays animated).
func Thumbnail(kind Kind, data []byte) ([]byte, error) {
	if kind == KindGIF {
		return nil, nil
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if cfg.Width <= ThumbMax && cfg.Height <= ThumbMax {
		return nil, nil
	}
	if cfg.Width*cfg.Height > MaxDecodePixels {
		return nil, fmt.Errorf("image too large to thumbnail (%dx%d)", cfg.Width, cfg.Height)
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	tw, th := fit(cfg.Width, cfg.Height, ThumbMax)
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	var buf bytes.Buffer
	if dst.Opaque() {
		err = jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 82})
	} else {
		err = png.Encode(&buf, dst)
	}
	return buf.Bytes(), err
}

func fit(w, h, limit int) (int, int) {
	if w >= h {
		return limit, max(1, h*limit/w)
	}
	return max(1, w*limit/h), limit
}
