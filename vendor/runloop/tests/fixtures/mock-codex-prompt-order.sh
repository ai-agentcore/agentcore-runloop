#!/bin/sh
cat "$CODEX_HOME/config.toml"
echo "---FILE---"
cat "$CODEX_HOME/model-instructions.md"
echo '{"type":"turn.completed","usage":{}}'
