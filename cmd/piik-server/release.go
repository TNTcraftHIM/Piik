package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"golang.org/x/mod/semver"
)

// The Browser notice and operator checker read the same published release.
const defaultReleaseAPIURL = "https://api.github.com/repos/TNTcraftHIM/Piik/releases/latest"
const mirrorReleaseAPIURL = "https://gitee.com/api/v5/repos/TNTcraftHIM/Piik/releases"

// deploy/check-release.sh forwards these codes without installing anything.
const (
	exitUpToDate          = 0
	exitUpdateAvailable   = 10
	exitUpdateUnavailable = 20
	releaseTimeout        = 5 * time.Second
	releaseURLPrefix      = "https://github.com/TNTcraftHIM/Piik/releases/tag/"
	releaseAPIHost        = "api.github.com"
	mirrorReleasePrefix   = "https://gitee.com/TNTcraftHIM/Piik/releases/tag/"
)

var fullRevisionPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
var mirrorSourcePattern = regexp.MustCompile(`(?m)^<!-- piik-source: ([0-9a-f]{40}) -->\r?$`)

const (
	statusUpToDate        = "up-to-date"
	statusUpdateAvailable = "update-available"
	statusDifferentBuild  = "different-build"
	statusOfficialRelease = "official-release"
	statusUnavailable     = "unavailable"
)

// Unknown identity fields are explicit nulls in the single printed JSON line.
type releaseResult struct {
	Status          string  `json:"status"`
	CurrentVersion  *string `json:"currentVersion"`
	LatestVersion   *string `json:"latestVersion"`
	CurrentRevision *string `json:"currentRevision"`
	LatestRevision  *string `json:"latestRevision"`
	ReleaseURL      *string `json:"releaseUrl"`
}

func checkDeployedRelease(ctx context.Context, apiURL string, out io.Writer) int {
	mirrorURL := ""
	if apiURL == defaultReleaseAPIURL {
		mirrorURL = mirrorReleaseAPIURL
	}
	result := checkRelease(ctx, BuildVersion, BuildRevision, apiURL, os.Getenv("GITHUB_TOKEN"), mirrorURL)
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(result); err != nil {
		return exitUpdateUnavailable
	}
	switch result.Status {
	case statusUpdateAvailable, statusDifferentBuild, statusOfficialRelease:
		return exitUpdateAvailable
	case statusUpToDate:
		return exitUpToDate
	default:
		return exitUpdateUnavailable
	}
}

func checkRelease(ctx context.Context, currentVersion, currentRevision, apiURL, token, mirrorURL string) releaseResult {
	result := unavailableResult(currentVersion, currentRevision)
	comparableVersion := result.CurrentVersion != nil && semver.IsValid(*result.CurrentVersion)
	if !comparableVersion && result.CurrentRevision == nil {
		return result
	}
	version, revision, releaseURL, ok := fetchLatestRelease(ctx, apiURL, token, false)
	if !ok && mirrorURL != "" {
		version, revision, releaseURL, ok = fetchLatestRelease(ctx, mirrorURL, "", true)
	}
	if !ok {
		return result
	}
	result.LatestVersion = &version
	result.LatestRevision = revisionOrNull(revision)
	result.ReleaseURL = &releaseURL
	if comparableVersion {
		result.Status = statusUpToDate
		order := semver.Compare(version, *result.CurrentVersion)
		if order > 0 {
			result.Status = statusUpdateAvailable
		} else if order == 0 && result.CurrentRevision != nil && result.LatestRevision != nil &&
			*result.CurrentRevision != *result.LatestRevision {
			result.Status = statusDifferentBuild
		}
	} else if result.CurrentRevision != nil && result.LatestRevision != nil {
		result.Status = statusOfficialRelease
		if *result.CurrentRevision == *result.LatestRevision {
			result.Status = statusUpToDate
		}
	}
	return result
}

// Routine startup only announces actionable release choices. An unavailable
// provider is not a server failure, and never changes the running installation.
func logReleaseNotice(logger *slog.Logger, result releaseResult) {
	var message string
	switch result.Status {
	case statusUpdateAvailable:
		message = "A newer Piik release is available"
	case statusDifferentBuild:
		message = "This Piik build differs from the official release"
	case statusOfficialRelease:
		message = "An official Piik release is available"
	default:
		return
	}
	current := "development"
	if result.CurrentVersion != nil {
		current = *result.CurrentVersion
	}
	logger.Info(message, "event", "release-check", "status", result.Status,
		"currentVersion", current, "latestVersion", *result.LatestVersion, "releaseUrl", *result.ReleaseURL)
}

func fetchLatestRelease(ctx context.Context, apiURL, token string, mirror bool) (version, revision, releaseURL string, ok bool) {
	endpoint, err := url.Parse(apiURL)
	if err != nil || (endpoint.Scheme != "https" && endpoint.Scheme != "http") {
		return "", "", "", false
	}
	ctx, cancel := context.WithTimeout(ctx, releaseTimeout)
	defer cancel()
	for page := 1; page <= 10; page++ {
		if mirror {
			query := endpoint.Query()
			query.Set("per_page", "100")
			query.Set("page", fmt.Sprint(page))
			query.Set("direction", "desc")
			endpoint.RawQuery = query.Encode()
		}
		body, err := readReleaseResponse(ctx, endpoint, token, mirror)
		if err != nil {
			return "", "", "", false
		}
		if !mirror {
			return parseReleaseMetadata(body)
		}
		var releases []json.RawMessage
		if err := json.Unmarshal(body, &releases); err != nil || releases == nil || len(releases) > 100 {
			return "", "", "", false
		}
		for _, payload := range releases {
			candidateVersion, candidateRevision, candidateURL, valid := parseMirrorReleaseMetadata(payload)
			if valid && (!ok || semver.Compare(candidateVersion, version) > 0) {
				version, revision, releaseURL, ok = candidateVersion, candidateRevision, candidateURL, true
			}
		}
		if len(releases) < 100 {
			return
		}
	}
	// Incomplete pagination cannot establish the highest stable version.
	return "", "", "", false
}

func readReleaseResponse(ctx context.Context, endpoint *url.URL, token string, mirror bool) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Piik-release-check")
	if !mirror {
		request.Header.Set("Accept", "application/vnd.github+json")
		request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		if authorizesGitHub(endpoint, token) {
			request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
		}
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("release endpoint redirected")
	}}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, errors.New("release endpoint unavailable")
	}
	const limit = 4 << 20
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || len(body) > limit {
		return nil, errors.New("release metadata unreadable or too large")
	}
	return body, nil
}

// Only the HTTPS GitHub API receives an operator token, and redirects are refused.
func authorizesGitHub(endpoint *url.URL, token string) bool {
	return endpoint.Scheme == "https" &&
		strings.ToLower(endpoint.Hostname()) == releaseAPIHost &&
		strings.TrimSpace(token) != ""
}

func unavailableResult(currentVersion, currentRevision string) releaseResult {
	currentVersion = strings.TrimSpace(currentVersion)
	if canonical := semver.Canonical(currentVersion); canonical != "" {
		currentVersion = canonical
	}
	result := releaseResult{Status: statusUnavailable, CurrentRevision: revisionOrNull(currentRevision)}
	if currentVersion != "" {
		result.CurrentVersion = &currentVersion
	}
	return result
}

func revisionOrNull(value string) *string {
	revision := strings.ToLower(strings.TrimSpace(value))
	if !fullRevisionPattern.MatchString(revision) {
		return nil
	}
	return &revision
}

type releaseMetadata struct {
	TagName         string `json:"tag_name"`
	HTMLURL         string `json:"html_url"`
	TargetCommitish string `json:"target_commitish"`
	Draft           bool   `json:"draft"`
	Prerelease      bool   `json:"prerelease"`
}

// A branch-valued target_commitish is unknown provenance, never a source SHA.
func parseReleaseMetadata(payload []byte) (version, revision, releaseURL string, ok bool) {
	var metadata releaseMetadata
	if err := json.Unmarshal(payload, &metadata); err != nil {
		return "", "", "", false
	}
	return normalizeReleaseMetadata(metadata)
}

func normalizeReleaseMetadata(metadata releaseMetadata) (version, revision, releaseURL string, ok bool) {
	if metadata.Draft || metadata.Prerelease {
		return "", "", "", false
	}
	version = metadata.TagName
	if version == "" || semver.Canonical(version) != version || semver.Prerelease(version) != "" ||
		metadata.HTMLURL != releaseURLPrefix+version {
		return "", "", "", false
	}
	if source := revisionOrNull(metadata.TargetCommitish); source != nil {
		revision = *source
	}
	return version, revision, metadata.HTMLURL, true
}

func parseMirrorReleaseMetadata(payload []byte) (version, revision, releaseURL string, ok bool) {
	var metadata struct {
		TagName    string `json:"tag_name"`
		Body       string `json:"body"`
		Prerelease *bool  `json:"prerelease"`
	}
	if err := json.Unmarshal(payload, &metadata); err != nil || metadata.Prerelease == nil || *metadata.Prerelease {
		return "", "", "", false
	}
	sources := mirrorSourcePattern.FindAllStringSubmatch(metadata.Body, -1)
	if len(sources) != 1 {
		return "", "", "", false
	}
	// The mirror's target_commitish identifies its README, not the original source.
	version, revision, _, ok = normalizeReleaseMetadata(releaseMetadata{
		TagName: metadata.TagName, TargetCommitish: sources[0][1], HTMLURL: releaseURLPrefix + metadata.TagName,
	})
	if !ok {
		return "", "", "", false
	}
	return version, revision, mirrorReleasePrefix + version, true
}
