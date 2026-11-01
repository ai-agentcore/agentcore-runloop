#!/bin/sh
echo '{"type":"item.streaming","item":{"type":"reasoning","text":"think-a"}}'
echo '{"type":"item.streaming","item":{"type":"reasoning","text":"think-b"}}'
echo '{"type":"item.completed","item":{"id":"r0","type":"reasoning","text":"think-ab"}}'
echo '{"type":"item.streaming","item":{"text":"answer"}}'
echo '{"type":"item.completed","item":{"id":"m0","type":"agent_message","text":"answer"}}'
echo '{"type":"turn.completed","usage":{}}'
