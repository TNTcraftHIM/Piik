package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// defaultReleaseAPIURL is DEFAULT_RELEASE_API_URL: the same published release
// contract the Browser update notice uses (src/client/lib/release-update.ts).
const defaultReleaseAPIURL = "https://api.github.com/repos/TNTcraftHIM/Piik/releases/latest"

// Exit codes are UPDATE_EXIT_CODES. deploy/check-release.sh forwards them, so a
// checker failure stays distinguishable from "an update exists".
const (
	exitUpToDate          = 0
	exitUpdateAvailable   = 10
	exitUpdateUnavailable = 20
	// exitUsage is the exit code parseArguments set when --current-file was
	// missing. Without it a forgotten argument reads as an unavailable check.
	exitUsage = 2
)

// releaseUsage is the usage string parseArguments threw, with this binary's
// name in place of the script's.
const releaseUsage = "Usage: piik-server --check-release --current-file <REVISION> [--api-url <URL>]"

const (
	// releaseTimeout bounds the whole check; an operator runs it interactively.
	releaseTimeout = 5 * time.Second
	// releasePathPrefix is RELEASE_PATH_PREFIX: the only accepted release page.
	releasePathPrefix = "/TNTcraftHIM/Piik/releases/tag/"
	releaseHost       = "github.com"
	releaseAPIHost    = "api.github.com"
)

// fullRevisionPattern is FULL_REVISION applied to an already lowercased value,
// which is why the JavaScript case-insensitive flag has no counterpart here.
var fullRevisionPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// Release status values are the "status" field of the printed JSON line, which
// deploy/check-release.sh reads; each maps to one exit code above.
const (
	statusUpToDate        = "up-to-date"
	statusUpdateAvailable = "update-available"
	statusUnavailable     = "unavailable"
)

// releaseResult is the single JSON line the checker prints. Field order is the
// JSON.stringify order of the ported object, and the pointers are the nulls: a
// value the check could not establish is present and null, never omitted.
type releaseResult struct {
	Status          string  `json:"status"`
	CurrentRevision *string `json:"currentRevision"`
	LatestRevision  *string `json:"latestRevision"`
	ReleaseURL      *string `json:"releaseUrl"`
}

// checkDeployedRelease is the --check-release entry point. It writes one JSON
// line and returns the process exit code. An unreadable revision file is an
// unavailable check rather than an update, which is what the ported script's
// silently swallowed read failure meant; an absent --current-file is a usage
// error, which is what parseArguments made it.
func checkDeployedRelease(ctx context.Context, currentFile, apiURL string, out io.Writer) int {
	if currentFile == "" {
		fmt.Fprintln(os.Stderr, releaseUsage)
		return exitUsage
	}
	current := ""
	if content, err := os.ReadFile(currentFile); err == nil {
		current = string(content)
	}
	result := checkRelease(ctx, current, apiURL, os.Getenv("GITHUB_TOKEN"))
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(result); err != nil {
		return exitUpdateUnavailable
	}
	switch result.Status {
	case statusUpdateAvailable:
		return exitUpdateAvailable
	case statusUpToDate:
		return exitUpToDate
	default:
		return exitUpdateUnavailable
	}
}

// checkRelease ports checkRelease. Every failure - an unusable current
// revision, an unusable endpoint, a redirect, a timeout, a non-2xx reply or
// metadata that fails validation - collapses to the same unavailable result:
// the checker never guesses that an update exists.
func checkRelease(ctx context.Context, currentRevision, apiURL, token string) releaseResult {
	current := normalizeRevision(currentRevision)
	if current == "" {
		return unavailableResult(currentRevision)
	}
	endpoint, err := url.Parse(apiURL)
	if err != nil || (endpoint.Scheme != "https" && endpoint.Scheme != "http") {
		return unavailableResult(current)
	}

	ctx, cancel := context.WithTimeout(ctx, releaseTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return unavailableResult(current)
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "Piik-release-check")
	if authorizesGitHub(endpoint, token) {
		request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	}

	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		// The ported redirect: "error" policy. A moved release endpoint is not
		// followed, so the Authorization header cannot travel to another origin.
		return errors.New("release endpoint redirected")
	}}
	response, err := client.Do(request)
	if err != nil {
		return unavailableResult(current)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return unavailableResult(current)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return unavailableResult(current)
	}
	latest, releaseURL, ok := parseReleaseMetadata(body)
	if !ok {
		return unavailableResult(current)
	}
	status := statusUpdateAvailable
	if latest == current {
		status = statusUpToDate
	}
	return releaseResult{
		Status:          status,
		CurrentRevision: &current,
		LatestRevision:  &latest,
		ReleaseURL:      &releaseURL,
	}
}

// authorizesGitHub reports whether the operator token may be sent to endpoint.
// A fixture, mirror or plaintext endpoint must never receive it, which is why
// the scheme and the host are both part of the rule.
func authorizesGitHub(endpoint *url.URL, token string) bool {
	return endpoint.Scheme == "https" &&
		strings.ToLower(endpoint.Hostname()) == releaseAPIHost &&
		strings.TrimSpace(token) != ""
}

// unavailableResult is unavailableResult: the current revision is reported when
// it is well formed and null otherwise.
func unavailableResult(currentRevision string) releaseResult {
	return releaseResult{Status: statusUnavailable, CurrentRevision: revisionOrNull(currentRevision)}
}

func revisionOrNull(value string) *string {
	revision := normalizeRevision(value)
	if revision == "" {
		return nil
	}
	return &revision
}

// normalizeRevision ports normalizeRevision, returning "" where it returned
// null: only a full 40-hex commit identifies a release.
func normalizeRevision(value string) string {
	revision := strings.ToLower(strings.TrimSpace(value))
	if !fullRevisionPattern.MatchString(revision) {
		return ""
	}
	return revision
}

// releaseMetadata is the subset of the GitHub release payload that is read.
// A tag_name or html_url of another type fails to decode, which is the
// rejection the JavaScript reached through typeof. Deviation: the JavaScript
// tested `draft === true`, so it read a draft of another type as "not a
// draft"; here such a payload fails to decode and the check reports
// unavailable. Only stricter, and a release payload the checker cannot
// understand must never be reported as an update.
type releaseMetadata struct {
	TagName    *string `json:"tag_name"`
	HTMLURL    *string `json:"html_url"`
	Draft      *bool   `json:"draft"`
	Prerelease *bool   `json:"prerelease"`
}

// parseReleaseMetadata ports parseReleaseMetadata. It accepts one shape only: a
// published, non-draft release whose tag is a full commit revision and whose
// page is exactly https://github.com/TNTcraftHIM/Piik/releases/tag/<that
// revision> with no credentials, port, query or fragment. The returned URL is
// rebuilt from the validated parts so nothing unverified reaches the operator.
func parseReleaseMetadata(payload []byte) (revision string, releaseURL string, ok bool) {
	var metadata releaseMetadata
	if err := json.Unmarshal(payload, &metadata); err != nil {
		return "", "", false
	}
	if (metadata.Draft != nil && *metadata.Draft) ||
		(metadata.Prerelease != nil && *metadata.Prerelease) {
		return "", "", false
	}
	if metadata.TagName == nil || metadata.HTMLURL == nil {
		return "", "", false
	}
	revision = normalizeRevision(*metadata.TagName)
	if revision == "" {
		return "", "", false
	}
	parsed, err := url.Parse(*metadata.HTMLURL)
	if err != nil || parsed.Scheme != "https" ||
		strings.ToLower(parsed.Hostname()) != releaseHost || parsed.User != nil ||
		parsed.Port() != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "", false
	}
	// The escaped path is compared, so an encoded separator such as %2F cannot
	// smuggle another path past the prefix the way the decoded form would.
	path := parsed.EscapedPath()
	if !strings.HasPrefix(path, releasePathPrefix) {
		return "", "", false
	}
	tag, err := url.PathUnescape(strings.TrimPrefix(path, releasePathPrefix))
	if err != nil || normalizeRevision(tag) != revision {
		return "", "", false
	}
	return revision, "https://" + releaseHost + path, true
}
