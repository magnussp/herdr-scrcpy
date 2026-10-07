#!/bin/sh
# Builds the native H.264 decoder. Runs as the plugin's [[build]] step on
# `herdr plugin install`; `herdr plugin link` does not run build steps, so run
# it yourself in a linked checkout. Optional argument: output path
# (default: bin/scrcpy-decode in the plugin directory).
set -eu
cd "$(dirname "$0")/.."
out=${1:-bin/scrcpy-decode}

if ! command -v pkg-config >/dev/null 2>&1; then
  echo "pkg-config not found (macOS: brew install pkg-config)" >&2
  exit 1
fi
if ! flags=$(pkg-config --cflags --libs libavcodec libavutil libswscale); then
  echo "FFmpeg development libraries not found (macOS: brew install ffmpeg)" >&2
  exit 1
fi

mkdir -p "$(dirname "$out")"
# $flags is intentionally unquoted: it is a list of compiler arguments.
# shellcheck disable=SC2086
${CC:-cc} -O2 -Wall -o "$out" native/decode.c $flags
echo "built $out"
