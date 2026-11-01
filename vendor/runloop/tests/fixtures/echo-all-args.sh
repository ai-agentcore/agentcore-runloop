#!/usr/bin/env bash
# Write last arg (the transcript) to a temp file for length-safe output
last_arg="${@: -1}"
printf '%s' "$last_arg"
