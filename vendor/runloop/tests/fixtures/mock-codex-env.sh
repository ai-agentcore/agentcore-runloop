#!/bin/sh
echo "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"ENV=$AGENTCORE_TEST_VAR\"}}"
echo '{"type":"turn.completed","usage":{}}'
