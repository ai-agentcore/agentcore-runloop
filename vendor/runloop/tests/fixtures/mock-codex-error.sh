#!/bin/sh
echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"error","message":"model not supported"}'
echo '{"type":"turn.failed","error":{"message":"model not supported"}}'
