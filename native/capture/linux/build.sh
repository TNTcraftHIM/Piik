#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || { [ "$#" -eq 2 ] && [ "$2" != "--check" ]; }; then
  echo "usage: build.sh <output-directory> [--check]" >&2
  exit 2
fi

output=$1
source_root=$(dirname "$0")
mkdir -p "$output"

build() {
  cc \
    -std=c11 -O2 -Wall -Wextra -Werror \
    "$source_root/$1" "$source_root/portal.c" \
    $(pkg-config --cflags --libs \
      libportal gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0) \
    -o "$output/$2"
}

build main.c piik-capture
if [ "${2:-}" = "--check" ]; then
  build main.test.c piik-capture-test
  "$output/piik-capture-test"
fi
