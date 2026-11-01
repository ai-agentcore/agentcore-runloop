#!/bin/sh
echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","tool":"mcp__agentcore__sandbox__mybox__exec","arguments":{},"result":{"ok":true}}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
