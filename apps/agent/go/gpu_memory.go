package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

var (
	gpuMemoryOnce  sync.Once
	gpuMemoryBytes *int64
)

// gpuMemory is the largest graphics card's dedicated memory in bytes, or nil
// when the OS does not say. Read once: it is asked on every status, and the
// card does not change while the agent runs.
func gpuMemory() *int64 {
	gpuMemoryOnce.Do(func() {
		if bytes := largest(readGPUMemory()); bytes > 0 {
			gpuMemoryBytes = &bytes
		}
	})
	return gpuMemoryBytes
}

func largest(values []int64) int64 {
	var best int64
	for _, v := range values {
		best = max(best, v)
	}
	return best
}

// parseByteLines reads one byte count per line, skipping anything else. Under
// 256 MB is skipped too: a driver that stores the size as REG_BINARY prints
// one small number per byte, which must not be read as a card.
func parseByteLines(text string) []int64 {
	var out []int64
	for _, line := range strings.Split(text, "\n") {
		if n, err := strconv.ParseInt(strings.TrimSpace(line), 10, 64); err == nil && n >= 256<<20 {
			out = append(out, n)
		}
	}
	return out
}

// amdgpuVRAM reads Linux amdgpu's own figure for each card. NVIDIA's CUDA
// total is already the card's size, so there is nothing to correct there.
func amdgpuVRAM() []int64 {
	paths, _ := filepath.Glob("/sys/class/drm/card*/device/mem_info_vram_total")
	var out []int64
	for _, path := range paths {
		if data, err := os.ReadFile(path); err == nil {
			out = append(out, parseByteLines(string(data))...)
		}
	}
	return out
}
