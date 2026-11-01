#!/bin/sh
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Let me check."}}'
echo '{"type":"item.completed","item":{"id":"tc-1","type":"tool_call","name":"exec_command","arguments":"{\"cmd\":\"ls\"}"}}'
echo '{"type":"item.completed","item":{"id":"tr-1","type":"tool_result","call_id":"tc-1","output":"files"}}'
echo '{"type":"item.completed","item":{"id":"m2","type":"agent_message","text":"Here are the results."}}'
echo '{"type":"item.completed","item":{"id":"tc-2","type":"tool_call","name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}'
echo '{"type":"item.completed","item":{"id":"tr-2","type":"tool_result","call_id":"tc-2","output":"content"}}'
echo '{"type":"item.completed","item":{"id":"m3","type":"agent_message","text":"Done."}}'
echo '{"type":"turn.completed","usage":{"input_tokens":500,"output_tokens":100}}'
