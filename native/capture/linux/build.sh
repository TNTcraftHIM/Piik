#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: build.sh <output-directory>" >&2
  exit 2
fi

output=$1
mkdir -p "$output"
cc \
  -std=c11 \
  -O2 \
  -Wall \
  -Wextra \
  -Werror \
  "$(dirname "$0")/main.c" \
  "$(dirname "$0")/portal.c" \
  $(pkg-config --cflags --libs \
    libportal \
    gstreamer-1.0 \
    gstreamer-app-1.0 \
    gstreamer-video-1.0) \
  -o "$output/piik-capture"
