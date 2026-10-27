package main

import "testing"

func TestParseByteLinesTakesTheCard(t *testing.T) {
	// PowerShell's output for an APU's integrated GPU beside a 16 GB card,
	// with the blank line an adapter without the value produces.
	got := largest(parseByteLines("536870912\r\n\r\n17163091968\r\n"))
	if got != 17163091968 {
		t.Fatalf("largest = %d, want the 16 GB card", got)
	}
	if largest(parseByteLines("")) != 0 {
		t.Fatal("no output should be no figure")
	}
}

func TestApplyStatsCapsBudgetAtCard(t *testing.T) {
	card := int64(16 << 30)
	s := ComfyState{GPUMemory: &card}
	s.applyStats(map[string]any{
		"system": map[string]any{"ram_total": float64(64 << 30), "ram_free": float64(40 << 30)},
		"devices": []any{
			map[string]any{"type": "cpu", "name": "cpu"},
			map[string]any{"type": "cuda", "name": "cuda:0 AMD Radeon RX 6900 XT : native", "vram_total": float64(39 << 30), "vram_free": float64(37 << 30)},
		},
	})
	if s.GPUName != "cuda:0 AMD Radeon RX 6900 XT : native" || *s.VRAMTotal != 16<<30 || *s.VRAMFree != 14<<30 || *s.RAMFree != 40<<30 {
		t.Fatalf("got %+v", s)
	}
}
