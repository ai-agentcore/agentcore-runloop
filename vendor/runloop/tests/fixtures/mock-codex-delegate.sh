#!/bin/sh
echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/bash -lc \".tools/agentrun call search_bot_delegate {}\"","aggregated_output":"sub-agent result","exit_code":0,"status":"completed"}}'
echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Done"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":30}}'
