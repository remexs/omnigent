#!/bin/sh
# Omnigent host 容器入口：登录 + 启动 host
# 环境变量：HOST_USER / HOST_PASS / OMNIGENT_SERVER
set -e
echo "[host] 登录 $OMNIGENT_SERVER 为 $HOST_USER ..."
# 用管道喂用户名/密码（accounts 交互模式）
printf '%s\n%s\n' "$HOST_USER" "$HOST_PASS" | omnigent login "$OMNIGENT_SERVER" >/dev/null 2>&1 || {
  echo "[host] 首次登录失败，重试..."
  printf '%s\n%s\n' "$HOST_USER" "$HOST_PASS" | omnigent login "$OMNIGENT_SERVER" || true
}
echo "[host] 启动 host ..."
exec omnigent host --server "$OMNIGENT_SERVER" --non-interactive
