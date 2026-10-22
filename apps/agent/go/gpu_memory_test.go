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
