package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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

// deploy/check-release.sh forwards these codes without installing anything.
const (
	exitUpToDate          = 0
	exitUpdateAvailable   = 10
	exitUpdateUnavailable = 20
	releaseTimeout        = 5 * time.Second
	releaseURLPrefix      = "https://github.com/TNTcraftHIM/Piik/releases/tag/"
	releaseAPIHost        = "api.github.com"
)

var fullRevisionPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

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
	result := checkRelease(ctx, BuildVersion, BuildRevision, apiURL, os.Getenv("GITHUB_TOKEN"))
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

func checkRelease(ctx context.Context, currentVersion, currentRevision, apiURL, token string) releaseResult {
	result := unavailableResult(currentVersion, currentRevision)
	comparableVersion := result.CurrentVersion != nil && semver.IsValid(*result.CurrentVersion)
	if !comparableVersion && result.CurrentRevision == nil {
		return result
	}
	endpoint, err := url.Parse(apiURL)
	if err != nil || (endpoint.Scheme != "https" && endpoint.Scheme != "http") {
		return result
	}

	ctx, cancel := context.WithTimeout(ctx, releaseTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return result
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "Piik-release-check")
	if authorizesGitHub(endpoint, token) {
		request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("release endpoint redirected")
	}}
	response, err := client.Do(request)
	if err != nil {
		return result
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return result
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return result
	}
	version, revision, releaseURL, ok := parseReleaseMetadata(body)
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
	if err := json.Unmarshal(payload, &metadata); err != nil || metadata.Draft || metadata.Prerelease {
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
