#!/bin/sh
echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","tool":"get_user_location","arguments":{},"result":{"status":"tool_pending"}}}'
echo '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","tool":"mcp__agentcore__get_user_location","arguments":{},"result":{"status":"tool_pending"}}}'
echo '{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","tool":"mcp__agentcore__real_tool","arguments":{"x":1},"result":{"ok":true}}}'
echo '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}'
