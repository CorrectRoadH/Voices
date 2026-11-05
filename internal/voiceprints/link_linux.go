package voiceprints

// Link the C++ runtime only for the native inference module. This also lets
// Nix's external linker retain its runtime search path.

// #cgo LDFLAGS: -lstdc++
import "C"
