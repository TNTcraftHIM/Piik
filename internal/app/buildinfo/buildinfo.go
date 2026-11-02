// Package buildinfo owns the build identity shared by App entry points.
package buildinfo

import (
	"runtime"
	"strings"

	"golang.org/x/mod/semver"
)

// Packagers inject these values into desktop and mobile builds.
var Release = "development"
var Revision = "development"

func PackageTarget() string {
	if runtime.GOOS == "android" {
		return "android-universal"
	}
	return runtime.GOOS + "-" + runtime.GOARCH
}

func Version() string {
	version := strings.TrimSpace(Release)
	if version != "" && semver.Canonical(version) == version && semver.Prerelease(version) == "" {
		return version
	}
	return "development"
}
