#!/bin/sh
echo '{"type":"item.completed","item":{"id":"p1","type":"todo_list","items":[{"content":"step A","status":"completed"},{"content":"step B","status":"in_progress"},{"content":"step C","status":"pending"}]}}'
echo '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"planned"}}'
echo '{"type":"turn.completed","usage":{}}'
