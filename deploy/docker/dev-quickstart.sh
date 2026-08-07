#!/usr/bin/env bash
# Omnigent 本地开发快速部署（WSL Docker）
#
# 核心思路：server 镜像用 editable install（.pth → /build/omnigent），
# 所以把源码目录挂载进容器覆盖 /build，Python 改动重启容器即生效；
# 前端改动只需重新构建 web-ui（npm run build → omnigent/server/static/web-ui/），
# 同样随挂载生效，无需重建镜像。
#
# 用法：
#   ./deploy/docker/dev-quickstart.sh up          # 启动 server + 多个 host
#   ./deploy/docker/dev-quickstart.sh rebuild-ui  # 只重构建前端 web-ui
#   ./deploy/docker/dev-quickstart.sh restart     # 重启容器（Python 改动后）
#   ./deploy/docker/dev-quickstart.sh logs [容器] # 看日志
#   ./deploy/docker/dev-quickstart.sh down        # 停容器
#
# 环境变量（默认值见下）：
#   OMNIGENT_IMAGE       server 镜像名（默认官方 ghcr.io/omnigent-ai/omnigent-server:latest）
#   OMNIGENT_HOST_IMAGE  host 镜像名（默认官方 ghcr.io/omnigent-ai/omnigent-host:latest）
#   OMNIGENT_HOSTS       逗号分隔的 host 名称列表（默认 zhangsan,lisi）
#   OMNIGENT_PORT        server 对外端口（默认 6767）
#   OMNIGENT_SRC         源码目录（默认当前仓库根）
#   POSTGRES_CONTAINER   postgres 容器名（默认 weclaw — 需已在 omnigent-net 网络）
#   POSTGRES_URL         数据库 URL（默认连 weclaw 的 omnigent 库）
#   OMNIGENT_PROVIDER_CONFIG  注入 host 的 provider 配置内容（默认 opencode-go 网关）
#   OMNIGENT_USERS       "user:pass" 列表（默认 admin:admin123!,zhangsan:Zhang3@123!,lisi:Lisi@123!）

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OMNIGENT_IMAGE="${OMNIGENT_IMAGE:-ghcr.io/omnigent-ai/omnigent-server:latest}"
OMNIGENT_HOST_IMAGE="${OMNIGENT_HOST_IMAGE:-ghcr.io/omnigent-ai/omnigent-host:latest}"
OMNIGENT_HOSTS="${OMNIGENT_HOSTS:-zhangsan,lisi}"
OMNIGENT_PORT="${OMNIGENT_PORT:-6767}"
OMNIGENT_SRC="${OMNIGENT_SRC:-$REPO_ROOT}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-weclaw}"
POSTGRES_URL="${POSTGRES_URL:-postgresql+psycopg://postgres:qm-dev@${POSTGRES_CONTAINER}:5432/omnigent}"
OMNIGENT_USERS="${OMNIGENT_USERS:-admin:admin123!,zhangsan:Zhang3@123!,lisi:Lisi@123!}"
PROVIDER_CONFIG="${PROVIDER_CONFIG:-providers:
  opencode-go:
    default: true
    kind: key
    openai:
      api_key: sk-iMNxWFPaaC85oqqZsXiWq0V8fsvMxaQaoU0WTllunIs7rMaD88johMWBkvBDImGk
      base_url: https://opencode.ai/zen/go/v1
      models:
        default: deepseek-v4-flash
}"

log() { echo -e "\033[1;36m[omnigent]\033[0m $*"; }

ensure_network() {
  if ! docker network inspect omnigent-net >/dev/null 2>&1; then
    docker network create omnigent-net
    log "创建 omnigent-net 网络"
  fi
  # 把 postgres 容器接入 omnigent-net（幂等）
  if docker ps -a --format '{{.Names}}' | grep -q "^${POSTGRES_CONTAINER}$"; then
    docker network connect omnigent-net "$POSTGRES_CONTAINER" 2>/dev/null || true
    log "postgres 容器 $POSTGRES_CONTAINER 已接入 omnigent-net"
  else
    log "⚠️  未找到 postgres 容器 $POSTGRES_CONTAINER — 请先启动 postgres（如 docker run -d --name weclaw -e POSTGRES_PASSWORD=qm-dev -p 5432:5432 postgres:16-alpine）"
  fi
}

up() {
  ensure_network

  # ── server ──
  docker rm -f omnigent-server >/dev/null 2>&1 || true
  log "启动 server 容器（挂载 $OMNIGENT_SRC → /build，Python 热更新）..."
  docker run -d --name omnigent-server \
    --network omnigent-net \
    -p "$OMNIGENT_PORT:8000" \
    -v "$OMNIGENT_SRC:/build" \
    -v "$OMNIGENT_SRC/deploy/docker/entrypoint.py:/app/entrypoint.py" \
    -v omnigent-data:/data \
    -e DATABASE_URL="$POSTGRES_URL" \
    -e ARTIFACT_DIR=/data/artifacts \
    -e PORT=8000 \
    -e HOST=0.0.0.0 \
    -e OMNIGENT_AUTH_ENABLED=1 \
    -e OMNIGENT_AUTH_PROVIDER=accounts \
    "$OMNIGENT_IMAGE" >/dev/null
  log "server 已启动 → http://localhost:$OMNIGENT_PORT（等几秒跑迁移 + 起服务）"

  # 等 server 健康
  for i in $(seq 1 20); do
    if curl -sf -m 2 "http://localhost:$OMNIGENT_PORT/health" >/dev/null 2>&1; then
      log "server 就绪 ✓"
      break
    fi
    sleep 2
  done

  # ── hosts ──
  IFS=',' read -ra HOSTS <<< "$OMNIGENT_HOSTS"
  for h in "${HOSTS[@]}"; do
    local cname="omnigent-host-$h"
    docker rm -f "$cname" >/dev/null 2>&1 || true

    # 取该 host 的用户凭据（默认同名，密码从 OMNIGENT_USERS 匹配）
    local huser="$h" hpass=""
    IFS=',' read -ra USERS <<< "$OMNIGENT_USERS"
    for u in "${USERS[@]}"; do
      if [[ "${u%%:*}" == "$h" ]]; then hpass="${u#*:}"; break; fi
    done
    [ -z "$hpass" ] && { log "⚠️  跳过 $h（OMNIGENT_USERS 无凭据）"; continue; }

    # 生成 host 配置目录（provider + 后续 login 态）
    local cfg_dir="/tmp/omnigent-host-$h-config"
    mkdir -p "$cfg_dir"
    printf '%s\n' "$PROVIDER_CONFIG" > "$cfg_dir/config.yaml"

    log "启动 host 容器 $cname（用户 $huser）..."
    docker run -d --name "$cname" \
      --network omnigent-net \
      -e HOST_USER="$huser" -e HOST_PASS="$hpass" \
      -e OMNIGENT_SERVER=http://omnigent-server:8000 \
      -v "$cfg_dir:/root/.omnigent" \
      -v "omnigent-workspace-$h:/workspace" \
      --entrypoint sh "$OMNIGENT_HOST_IMAGE" \
      -c 'mkdir -p /workspace && printf "%s\n%s\n" "$HOST_USER" "$HOST_PASS" | omnigent login "$OMNIGENT_SERVER" >/dev/null 2>&1; exec omnigent host --server "$OMNIGENT_SERVER" --non-interactive' >/dev/null
    log "  $cname 已启动（用户 $huser）"
  done
  log "全部启动 ✓  host 状态: docker logs omnigent-host-<name>"
}

rebuild-ui() {
  log "重新构建前端 web-ui..."
  (cd "$REPO_ROOT/web" && npm install && npm run build)
  log "web-ui 已更新 → 重启 server: ./deploy/docker/dev-quickstart.sh restart"
}

restart() {
  log "重启 server 容器（Python/前端改动生效）..."
  docker restart omnigent-server >/dev/null
  log "已重启 ✓  http://localhost:$OMNIGENT_PORT"
}

logs()   { docker logs -f --tail 100 "${1:-omnigent-server}"; }
down()   { docker rm -f omnigent-server $(docker ps -aq --filter name=omnigent-host-) >/dev/null 2>&1; log "已停止所有 omnigent 容器（数据保留）"; }

case "${1:-}" in
  up) up ;;
  rebuild-ui) rebuild-ui ;;
  restart) restart ;;
  logs) logs "${2:-}" ;;
  down) down ;;
  *) echo "用法: $0 {up|rebuild-ui|restart|logs|down}"; exit 1 ;;
esac
