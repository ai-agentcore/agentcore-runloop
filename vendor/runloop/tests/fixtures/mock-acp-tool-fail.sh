#!/bin/sh
# Mock ACP agent: reads JSON-RPC from stdin, responds on stdout
read line
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
read line
echo '{"jsonrpc":"2.0","id":2,"result":{"conversationId":"s1"}}'
read line
echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"tool_call","toolCall":{"toolCallId":"tc-f","name":"bad_tool","status":"failed","rawOutput":"permission denied"}}}'
echo '{"jsonrpc":"2.0","id":3,"result":{}}'
exit 0
