#!/usr/bin/env bash
# Mock agent CLI for testing.
# Outputs a JSON result envelope with sanitized last argument.

last_arg="${@: -1}"
safe_arg=$(printf '%s' "$last_arg" | tr '\n' ' ' | head -c 200)

cat <<EOF
{"type":"result","result":"Mock response to: $safe_arg","usage":{"input_tokens":50,"output_tokens":10},"total_cost_usd":0.0005}
EOF
