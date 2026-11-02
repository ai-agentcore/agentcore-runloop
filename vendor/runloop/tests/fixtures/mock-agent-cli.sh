#!/usr/bin/env bash
set -eu
printf '%s\n' '{"type":"thread.started","thread_id":"fixture"}' '{"type":"turn.started"}'
printf '%s\n' '{"type":"item.completed","item":{"id":"msg1","type":"agent_message","text":"Mock response"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":10}}'
