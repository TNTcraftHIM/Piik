#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: build.sh <output-directory>" >&2
  exit 2
fi

output=$1
architecture=$(uname -m)
case "$architecture" in
  arm64|x86_64) ;;
  *) echo "unsupported macOS capture architecture: $architecture" >&2; exit 2 ;;
esac
mkdir -p "$output"
xcrun swiftc \
  -O \
  -parse-as-library \
  -swift-version 5 \
  -target "$architecture-apple-macos13.0" \
  -framework AVFoundation \
  -framework AudioToolbox \
  -framework CoreAudio \
  -framework CoreMedia \
  -framework CoreVideo \
  -framework ScreenCaptureKit \
  -framework VideoToolbox \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$(dirname "$0")/Info.plist" \
  "$(dirname "$0")/main.swift" \
  -o "$output/piik-capture"
