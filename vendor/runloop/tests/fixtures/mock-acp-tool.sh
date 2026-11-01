#!/bin/sh
# Mock ACP agent: reads JSON-RPC from stdin, responds on stdout
read line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"conversationId":"s1"}}'
read line
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"tool_call","toolCall":{"toolCallId":"tc-1","name":"read_file","status":"in_progress","kind":"read"}}}'
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"tool_call","toolCall":{"toolCallId":"tc-1","name":"read_file","status":"completed","rawOutput":"content"}}}'
echo '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
exit 0
