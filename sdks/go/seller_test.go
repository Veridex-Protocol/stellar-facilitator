package veridex

import "testing"

// The soft-drop rules these functions implement are a trust boundary: a hostile
// client controls this metadata and the catalog is public. Each test states the
// attack or mistake it rejects.

func TestIsValidServiceName(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  bool
	}{
		{"ordinary name", "Acme forecasts", true},
		{"single character", "a", true},
		{"exactly 32 characters", "abcdefghijabcdefghijabcdefghijab", true},
		{"33 characters", "abcdefghijabcdefghijabcdefghijabc", false},
		{"empty", "", false},
		{"newline breaks a single-line field", "Acme\nforecasts", false},
		{"tab is not printable ASCII", "Acme\tforecasts", false},
		{"non-ASCII", "Acmé forecasts", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsValidServiceName(tc.input); got != tc.want {
				t.Errorf("IsValidServiceName(%q) = %v, want %v", tc.input, got, tc.want)
			}
		})
	}
}

func TestSanitizeTags(t *testing.T) {
	t.Run("keeps at most five tags", func(t *testing.T) {
		got := SanitizeTags([]string{"a", "b", "c", "d", "e", "f", "g"})
		if len(got) != 5 {
			t.Errorf("kept %d tags, want 5", len(got))
		}
	})

	t.Run("drops tags that are too long", func(t *testing.T) {
		long := "abcdefghijabcdefghijabcdefghijabc" // 33
		got := SanitizeTags([]string{"weather", long})
		for _, tag := range got {
			if tag == long {
				t.Error("kept a tag longer than 32 characters")
			}
		}
	})

	t.Run("drops tags that are not printable ASCII", func(t *testing.T) {
		got := SanitizeTags([]string{"weather", "for\ncast"})
		for _, tag := range got {
			if tag == "for\ncast" {
				t.Error("kept a tag containing a newline")
			}
		}
	})

	t.Run("an empty list stays empty", func(t *testing.T) {
		if got := SanitizeTags(nil); len(got) != 0 {
			t.Errorf("got %d tags from nil, want 0", len(got))
		}
	})
}

func TestIsValidIconURL(t *testing.T) {
	// These reject SSRF vectors: a catalog that renders an icon must not be
	// steered at an internal address.
	cases := []struct {
		name  string
		input string
		want  bool
	}{
		{"ordinary https url", "https://example.com/icon.png", true},
		{"loopback by name", "http://localhost/icon.png", false},
		{"loopback by address", "http://127.0.0.1/icon.png", false},
		{"IPv6 loopback", "http://[::1]/icon.png", false},
		{"private range", "http://10.0.0.1/icon.png", false},
		{"link-local metadata address", "http://169.254.169.254/icon.png", false},
		{"hex-encoded loopback", "http://0x7f000001/icon.png", false},
		{"decimal-encoded loopback", "http://2130706433/icon.png", false},
		{"empty", "", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsValidIconURL(tc.input); got != tc.want {
				t.Errorf("IsValidIconURL(%q) = %v, want %v", tc.input, got, tc.want)
			}
		})
	}
}

func TestIsValidRouteTemplate(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  bool
	}{
		{"simple path", "/forecast", true},
		{"path parameter", "/weather/:country/:city", true},
		{"traversal", "/weather/../../etc/passwd", false},
		{"percent-encoded traversal", "/weather/%2e%2e/%2e%2e/etc", false},
		{"scheme injection", "/weather/https://evil.test", false},
		{"does not start with a slash", "weather", false},
		{"empty", "", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsValidRouteTemplate(tc.input); got != tc.want {
				t.Errorf("IsValidRouteTemplate(%q) = %v, want %v", tc.input, got, tc.want)
			}
		})
	}
}

func TestCreateBazaarMetadata(t *testing.T) {
	t.Run("keeps valid metadata intact", func(t *testing.T) {
		got := CreateBazaarMetadata(
			"Hourly weather forecast for a named city.",
			map[string]interface{}{"type": "object"},
			"Acme forecasts",
			[]string{"weather", "forecast"},
			"https://example.com/icon.png",
			"/weather/:city",
			"",
			nil,
		)
		if got.ServiceName != "Acme forecasts" {
			t.Errorf("ServiceName = %q, want %q", got.ServiceName, "Acme forecasts")
		}
		if len(got.Tags) != 2 {
			t.Errorf("Tags = %v, want 2 entries", got.Tags)
		}
		if got.MimeType != "application/json" {
			t.Errorf("MimeType = %q, want the application/json default", got.MimeType)
		}
	})

	t.Run("drops an oversized service name rather than truncating it", func(t *testing.T) {
		// Truncation would silently change what the seller published.
		got := CreateBazaarMetadata(
			"A description.",
			map[string]interface{}{"type": "object"},
			"this service name is very much longer than thirty-two characters",
			nil, "", "", "", nil,
		)
		if got.ServiceName != "" {
			t.Errorf("ServiceName = %q, want it dropped", got.ServiceName)
		}
	})

	t.Run("drops tags beyond the fifth", func(t *testing.T) {
		got := CreateBazaarMetadata(
			"A description.",
			map[string]interface{}{"type": "object"},
			"Acme",
			[]string{"a", "b", "c", "d", "e", "f"},
			"", "", "", nil,
		)
		if len(got.Tags) > 5 {
			t.Errorf("kept %d tags, want at most 5", len(got.Tags))
		}
	})
}

func TestValidateBazaarMetadata(t *testing.T) {
	t.Run("accepts valid metadata", func(t *testing.T) {
		result := ValidateBazaarMetadata(&BazaarMetadata{
			ServiceName:   "Acme forecasts",
			Tags:          []string{"weather"},
			IconURL:       "https://example.com/icon.png",
			RouteTemplate: "/weather/:city",
		})
		if !result.Valid {
			t.Errorf("valid metadata rejected: %v", result.Errors)
		}
	})

	t.Run("reports why it rejected, not merely that it did", func(t *testing.T) {
		// A seller cannot fix a listing from a bare false.
		result := ValidateBazaarMetadata(&BazaarMetadata{
			ServiceName:   "Acme\nforecasts",
			RouteTemplate: "/../etc/passwd",
		})
		if result.Valid {
			t.Fatal("hostile metadata accepted")
		}
		if len(result.Errors) == 0 {
			t.Error("rejected with no stated reason")
		}
	})
}
