#!/usr/bin/env bash
set -eu
printf '%s\n' '{"type":"turn.started"}'
printf '{"type":"item.completed","item":{"id":"pwd","type":"agent_message","text":"%s"}}\n' "$PWD"
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
