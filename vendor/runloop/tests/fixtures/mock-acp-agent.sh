#!/bin/sh
# Mock ACP agent: reads JSON-RPC from stdin, responds on stdout
# Read and respond to initialize
read line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}'

# Read and respond to session/new
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"conversationId":"mock-session-1"}}'

# Read session/prompt and emit update + response
read line
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"message","content":"Hello from ACP"}}'
echo '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'

# Exit cleanly
exit 0
