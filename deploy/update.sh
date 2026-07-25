#!/usr/bin/env bash
# 兼容入口：bash deploy/update.sh
exec "$(cd "$(dirname "$0")/.." && pwd)/update.sh"
