package files

import "time"

// SetVariantTimeout changes the deadline for making a variant (slot wait and
// imgproxy request); call restore when done. Tests in this package do not run in parallel.
func SetVariantTimeout(d time.Duration) (restore func()) {
	old := variantTimeout
	variantTimeout = d
	return func() { variantTimeout = old }
}

// SetVariantSlots changes how many imgproxy requests services set up after
// the call make at once; call restore when done.
func SetVariantSlots(n int) (restore func()) {
	old := variantSlots
	variantSlots = n
	return func() { variantSlots = old }
}
