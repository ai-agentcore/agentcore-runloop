#!/bin/sh
echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"tc-1","type":"tool_call","name":"my_tool","arguments":"{}invalid"}}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}'
echo '{"type":"turn.completed","usage":{}}'
