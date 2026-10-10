package files_test

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
)

func pngImage(w, h int, alpha bool) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	a := uint8(255)
	if alpha {
		a = 128
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 200, A: a})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

func jpegImage(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 4), G: uint8(y * 4), B: 90, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

func gifImage(w, h int) []byte {
	img := image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{color.Black, color.White})
	var buf bytes.Buffer
	if err := gif.Encode(&buf, img, nil); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

// exifSegment builds a JPEG APP1 Exif segment holding an orientation tag
// and an ImageDescription carrying marker (a stand-in for GPS data etc.).
func exifSegment(orientation uint16, marker string) []byte {
	le := binary.LittleEndian
	var t bytes.Buffer
	t.WriteString("II*\x00")
	_ = binary.Write(&t, le, uint32(8)) // IFD0 offset
	_ = binary.Write(&t, le, uint16(2)) // two entries
	// Orientation: SHORT, count 1, value inline.
	_ = binary.Write(&t, le, uint16(0x0112))
	_ = binary.Write(&t, le, uint16(3))
	_ = binary.Write(&t, le, uint32(1))
	_ = binary.Write(&t, le, orientation)
	_ = binary.Write(&t, le, uint16(0))
	// ImageDescription: ASCII stored after the IFD.
	desc := marker + "\x00"
	_ = binary.Write(&t, le, uint16(0x010E))
	_ = binary.Write(&t, le, uint16(2))
	_ = binary.Write(&t, le, uint32(len(desc)))
	_ = binary.Write(&t, le, uint32(8+2+2*12+4))
	_ = binary.Write(&t, le, uint32(0)) // no next IFD
	t.WriteString(desc)
	payload := append([]byte("Exif\x00\x00"), t.Bytes()...)
	n := len(payload) + 2
	return append([]byte{0xFF, 0xE1, byte(n >> 8), byte(n)}, payload...)
}

func comSegment(text string) []byte {
	n := len(text) + 2
	return append([]byte{0xFF, 0xFE, byte(n >> 8), byte(n)}, text...)
}

// withSegments inserts JPEG segments right after the SOI marker.
func withSegments(jpg []byte, segs ...[]byte) []byte {
	out := append([]byte{}, jpg[:2]...)
	for _, s := range segs {
		out = append(out, s...)
	}
	return append(out, jpg[2:]...)
}

// pngWithText adds a tEXt chunk just before IEND.
func pngWithText(p []byte, key, text string) []byte {
	data := append([]byte(key+"\x00"), text...)
	chunk := make([]byte, 4, 12+len(data))
	binary.BigEndian.PutUint32(chunk, uint32(len(data)))
	chunk = append(chunk, "tEXt"...)
	chunk = append(chunk, data...)
	chunk = binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(chunk[4:]))
	iend := len(p) - 12
	out := append([]byte{}, p[:iend]...)
	out = append(out, chunk...)
	return append(out, p[iend:]...)
}

// tinyWebP is a valid 1x1 lossless WebP.
const tinyWebP = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="

// webpWithExif wraps tinyWebP in an extended (VP8X) container that declares
// and carries an EXIF chunk.
func webpWithExif(marker string) []byte {
	base, err := base64.StdEncoding.DecodeString(tinyWebP)
	if err != nil {
		panic(err)
	}
	vp8l := base[12:]                                                                // the VP8L chunk, header and padding included
	vp8x := []byte{'V', 'P', '8', 'X', 10, 0, 0, 0, 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0} // EXIF flag; 1x1 canvas
	exifData := []byte("Exif\x00\x00" + marker)
	exif := []byte("EXIF")
	exif = binary.LittleEndian.AppendUint32(exif, uint32(len(exifData)))
	exif = append(exif, exifData...)
	if len(exifData)%2 == 1 {
		exif = append(exif, 0)
	}
	body := append([]byte("WEBP"), vp8x...)
	body = append(body, vp8l...)
	body = append(body, exif...)
	out := []byte("RIFF")
	out = binary.LittleEndian.AppendUint32(out, uint32(len(body)))
	return append(out, body...)
}

// pngClaiming is a tiny PNG whose header claims w x h pixels: enough to be
// measured, too big to decode.
func pngClaiming(w, h int) []byte {
	p := pngImage(1, 1, false)
	binary.BigEndian.PutUint32(p[16:], uint32(w))
	binary.BigEndian.PutUint32(p[20:], uint32(h))
	binary.BigEndian.PutUint32(p[29:], crc32.ChecksumIEEE(p[12:29]))
	return p
}

// gifClaiming is a tiny GIF whose logical screen is w x h pixels.
func gifClaiming(w, h int) []byte {
	g := gifImage(2, 2)
	binary.LittleEndian.PutUint16(g[6:], uint16(w))
	binary.LittleEndian.PutUint16(g[8:], uint16(h))
	return g
}

// mp4Video is n bytes that sniff as video/mp4: an ftyp box (brand isom,
// compatible with mp41), then zeros.
func mp4Video(n int) []byte {
	b := []byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 2, 0, 'i', 's', 'o', 'm', 'm', 'p', '4', '1'}
	return append(b, make([]byte, n-len(b))...)
}
