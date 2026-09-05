#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: build.sh <output-directory>" >&2
  exit 2
fi

output=$1
mkdir -p "$output"
xcrun swiftc \
  -O \
  -parse-as-library \
  -swift-version 5 \
  -target arm64-apple-macos13.0 \
  -framework AudioToolbox \
  -framework CoreMedia \
  -framework CoreVideo \
  -framework ScreenCaptureKit \
  -framework VideoToolbox \
  "$(dirname "$0")/main.swift" \
  -o "$output/screener-client-capture"
