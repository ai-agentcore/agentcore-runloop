#!/bin/sh
echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"tc-1","type":"tool_call","name":"read_file","arguments":"{\"path\":\"test.txt\"}"}}'
echo '{"type":"item.completed","item":{"id":"tr-1","type":"tool_result","call_id":"tc-1","output":"file contents"}}'
echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Done"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":200,"output_tokens":30}}'
