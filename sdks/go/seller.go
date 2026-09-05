// Veridex SDK - Go Seller Helpers
// License: Apache-2.0
//
// Helper functions for resource servers to declare Bazaar discovery metadata

package veridex

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/url"
	"regexp"
	"strings"
)

// ProviderOutcome is the digest-only, signed response record used by a seller.
type ProviderOutcome struct {
	Version         string `json:"v"`
	Resource        string `json:"resource"`
	PayTo           string `json:"payTo"`
	RequestDigest   string `json:"requestDigest"`
	ResponseDigest  string `json:"responseDigest"`
	ObservedAt      int64  `json:"observedAt"`
	Usable          bool   `json:"usable"`
	ProviderAtFault bool   `json:"providerAtFault"`
	Attributable    string `json:"attributable"`
	ReasonCode      string `json:"reasonCode"`
	UsageAtomic     string `json:"usageAtomic,omitempty"`
	Signer          string `json:"signer"`
	Signature       string `json:"signature"`
}

// SHA256Digest returns the digest format shared by the TypeScript and Python SDKs.
func SHA256Digest(value []byte) string {
	sum := sha256.Sum256(value)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// MarshalProviderOutcome returns canonical JSON-ready bytes for transport.
func MarshalProviderOutcome(outcome ProviderOutcome) ([]byte, error) {
	return json.Marshal(outcome)
}

// BazaarMetadata represents Bazaar discovery metadata
type BazaarMetadata struct {
	ServiceName   string                 `json:"serviceName,omitempty"`
	Description   string                 `json:"description"`
	Tags          []string               `json:"tags,omitempty"`
	IconURL       string                 `json:"iconUrl,omitempty"`
	RouteTemplate string                 `json:"routeTemplate,omitempty"`
	MimeType      string                 `json:"mimeType,omitempty"`
	InputSpec     map[string]interface{} `json:"inputSpec"`
	OutputSpec    map[string]interface{} `json:"outputSpec,omitempty"`
}

// ValidationResult contains validation results
type ValidationResult struct {
	Valid  bool     `json:"valid"`
	Errors []string `json:"errors"`
}

var (
	printableASCII = regexp.MustCompile(`^[\x20-\x7e]+$`)
	ipLiteral      = regexp.MustCompile(`^\d+\.\d+\.\d+\.\d+$`)
	encodedIP      = regexp.MustCompile(`^(0x[0-9a-f]+|\d+)$`)
)

// validServiceName returns the name when it passes the soft-drop rules, and
// the empty string otherwise.
func validServiceName(serviceName string) string {
	if IsValidServiceName(serviceName) {
		return serviceName
	}
	return ""
}

// CreateBazaarMetadata creates Bazaar discovery metadata with automatic validation
func CreateBazaarMetadata(
	description string,
	inputSpec map[string]interface{},
	serviceName string,
	tags []string,
	iconURL string,
	routeTemplate string,
	mimeType string,
	outputSpec map[string]interface{},
) *BazaarMetadata {
	if mimeType == "" {
		mimeType = "application/json"
	}

	sanitizedTags := SanitizeTags(tags)

	return &BazaarMetadata{
		// Dropped rather than truncated: truncating would silently publish
		// something the seller did not write.
		ServiceName:   validServiceName(serviceName),
		Description:   description,
		Tags:          sanitizedTags,
		IconURL:       iconURL,
		RouteTemplate: routeTemplate,
		MimeType:      mimeType,
		InputSpec:     inputSpec,
		OutputSpec:    outputSpec,
	}
}

// IsValidServiceName validates service name (printable ASCII, max 32 chars)
func IsValidServiceName(serviceName string) bool {
	if serviceName == "" || len(serviceName) > 32 {
		return false
	}

	return printableASCII.MatchString(serviceName)
}

// SanitizeTags sanitizes tags array (printable ASCII, max 32 chars, max 5 tags, deduplicated)
func SanitizeTags(tags []string) []string {
	seen := make(map[string]bool)
	sanitized := []string{}

	for _, tag := range tags {
		// Skip if already seen (case-insensitive)
		normalized := strings.ToLower(tag)
		if seen[normalized] {
			continue
		}

		// Validate printable ASCII and length
		if printableASCII.MatchString(tag) && len(tag) <= 32 {
			sanitized = append(sanitized, tag)
			seen[normalized] = true
		}

		// Max 5 tags
		if len(sanitized) >= 5 {
			break
		}
	}

	return sanitized
}

// IsValidIconURL validates icon URL (no IP literals, localhost, decimal/hex IPs)
func IsValidIconURL(iconURL string) bool {
	// An absent icon is not a valid icon URL. Returning true for the empty
	// string made every caller that treated this as "safe to render" wrong.
	if iconURL == "" {
		return false
	}

	parsedURL, err := url.Parse(iconURL)
	if err != nil {
		return false
	}

	hostname := parsedURL.Hostname()
	if hostname == "" {
		return false
	}

	// Reject IP literals, in either family. url.Hostname strips the brackets
	// from an IPv6 authority, so ParseIP is what catches "[::1]".
	if ipLiteral.MatchString(hostname) || net.ParseIP(hostname) != nil {
		return false
	}

	// Reject localhost and loopback names
	lower := strings.ToLower(hostname)
	if lower == "localhost" || lower == "ip6-loopback" || strings.HasSuffix(lower, ".localhost") {
		return false
	}

	// Reject decimal/hex encoded IPs
	if encodedIP.MatchString(hostname) {
		return false
	}

	return true
}

// IsValidRouteTemplate validates route template (no path traversal, no scheme injection)
func IsValidRouteTemplate(routeTemplate string) bool {
	// A route template is a path, so it must be non-empty and rooted. Accepting
	// "weather" or "" let a caller publish something that is not a path at all.
	if routeTemplate == "" || !strings.HasPrefix(routeTemplate, "/") {
		return false
	}

	decoded, err := url.QueryUnescape(routeTemplate)
	if err != nil {
		return false
	}

	// Reject path traversal
	if strings.Contains(decoded, "..") {
		return false
	}

	// Reject URL scheme injection
	if strings.Contains(decoded, "://") {
		return false
	}

	return true
}

// ValidateBazaarMetadata validates complete Bazaar metadata
func ValidateBazaarMetadata(metadata *BazaarMetadata) *ValidationResult {
	errors := []string{}

	// Validate serviceName
	if metadata.ServiceName != "" && !IsValidServiceName(metadata.ServiceName) {
		errors = append(errors, "serviceName must be printable ASCII and max 32 characters")
	}

	// Validate tags
	if len(metadata.Tags) > 5 {
		errors = append(errors, "maximum 5 tags allowed")
	}
	for _, tag := range metadata.Tags {
		if !printableASCII.MatchString(tag) || len(tag) > 32 {
			errors = append(errors, "invalid tag: "+tag)
		}
	}

	// Validate iconURL
	if metadata.IconURL != "" && !IsValidIconURL(metadata.IconURL) {
		errors = append(errors, "iconURL must not contain IP literals, localhost, or encoded IPs")
	}

	// Validate routeTemplate
	if metadata.RouteTemplate != "" && !IsValidRouteTemplate(metadata.RouteTemplate) {
		errors = append(errors, "routeTemplate must not contain path traversal (..) or scheme injection (://)")
	}

	return &ValidationResult{
		Valid:  len(errors) == 0,
		Errors: errors,
	}
}
