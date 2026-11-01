#!/bin/sh
echo '{"type":"assistant","tool_use":{"name":"read_file","id":"tc-1","input":{"path":"test.txt"}}}'
echo '{"type":"assistant","tool_result":{"id":"tc-1","content":"file contents"}}'
echo '{"type":"result","usage":{}}'
