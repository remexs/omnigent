# Omnigent 多机部署指南

> 目标：一台协调服务器 + 多台开发笔记本（host）的联合编排。
> 架构说明见 [`MULTI_MACHINE_ARCHITECTURE.md`](MULTI_MACHINE_ARCHITECTURE.md)。

## 目录

1. [前置准备](#1-前置准备)
2. [协调服务器部署](#2-协调服务器部署)
3. [防火墙放行](#3-防火墙放行)
4. [开发笔记本接入](#4-开发笔记本接入)
5. [管理员账号与成员管理](#5-管理员账号与成员管理)
6. [验证](#6-验证)
7. [日常运维](#7-日常运维)
8. [故障排查](#8-故障排查)
9. [安全建议](#9-安全建议)

---

## 1. 前置准备

| 项目 | 要求 |
|------|------|
| 协调服务器 | Linux（麒麟/Ubuntu/CentOS），Python 3.12，2GB+ 内存 |
| 开发笔记本 | Linux / macOS / Windows(WSL2)，Python 3.12 |
| 网络 | 服务器 6767 端口对全部 host 可达；host 能出站连服务器 |
| 模型 | 各 host 自行配置（如 goose + DeepSeek） |

---

## 2. 协调服务器部署

### 2.1 安装依赖

```bash
# 安装 uv（如未装）
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH=$HOME/.local/bin:$PATH

# 安装 git（harness 需要）
yum install -y git || apt-get install -y git

# 安装 Python 3.12（uv 管理）
uv python install 3.12

# 安装 Omnigent（正式版从 PyPI）
uv tool install --python 3.12 omnigent

# 或从源码安装（开发版，与仓库同步）
# git clone https://github.com/omnigent-ai/omnigent.git /opt/omnigent-src
# uv tool install --editable --python 3.12 /opt/omnigent-src
```

> ⚠️ **版本一致性**：协调服务器与所有 host 的 omnigent **版本必须一致**（如 0.8.0.dev0），否则 host 隧道握手失败。用 `omnigent --version` 核对。

### 2.2 启动服务器（accounts 模式）

```bash
# 关键：绑定 0.0.0.0 自动启用 accounts 认证（安全）
# 首次启动用 --admin-password 预置管理员密码（密码必须满足复杂度要求）
nohup omnigent server --host 0.0.0.0 --port 6767 \
  --admin-password '你的强密码' \
  > /var/log/omni-server.log 2>&1 &

# 验证
curl http://127.0.0.1:6767/api/version   # {"version":"0.8.0.dev0"}
curl http://127.0.0.1:6767/v1/info        # accounts_enabled: true
```

> ⚠️ **不要用 `OMNIGENT_AUTH_ENABLED=0`**：单用户模式下远程 host 会被 403 拒绝（owner 校验）。多机协作必须走 accounts 模式。

### 2.3 开机自启（可选）

```bash
# systemd 服务示例 /etc/systemd/system/omnigent.service
cat > /etc/systemd/system/omnigent.service <<'EOF'
[Unit]
Description=Omnigent Coordinator Server
After=network.target

[Service]
Type=simple
User=root
ExecStart=/root/.local/bin/omnigent server --host 0.0.0.0 --port 6767
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now omnigent
```

---

## 3. 防火墙放行

### 3.1 服务器防火墙（firewalld）

```bash
# 放行 6767（关键！默认只放行 ssh/3306）
firewall-cmd --permanent --add-port=6767/tcp
firewall-cmd --reload

# 验证
firewall-cmd --query-port=6767/tcp   # yes
```

### 3.2 常见坑

- **麒麟/CentOS firewalld**：默认只放行 `cockpit dhcpv6-client mdns ssh`，**6767 必须手动加**
- **Windows 主机（WSL 场景）**：若服务器跑在 WSL 里，需在 Windows 防火墙放行 6767，并确认 WSL 网络模式（镜像模式可与 Windows 共享 IP）
- **网关/ACL**：两个子网间的网关若只放行 SSH，WebSocket(6767) 会被拦——需放行或走同网段

---

## 4. 开发笔记本接入

### 4.1 安装

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH=$HOME/.local/bin:$PATH
uv python install 3.12
uv tool install --python 3.12 omnigent
# 源码版请用与服务器相同的安装方式，保持版本一致
```

### 4.2 登录协调服务器

```bash
omnigent login http://192.168.10.20:6767
# 输入管理员分配的 用户名 + 密码
# 成功输出: Logged in as <user>. Set ... as your default server.
```

### 4.3 注册为 host

```bash
omnigent host http://192.168.10.20:6767
# 成功输出: ✓ Connected as '<hostname>' (host_id), Listening for sessions
```

> host 是**前台常驻命令**：用 `nohup ... &` 或 systemd 保持运行；Ctrl-C 断开。

### 4.4 配置本机模型/harness

```bash
# 例：goose（最简）
omnigent setup   # 选择 provider + 模型

# 查看本机已配置的 harness（在服务器 hosts 列表可见）
omnigent host status
```

---

## 5. 管理员账号与成员管理

### 5.1 初始 admin

- 用户名 = **服务器 OS 用户名**（如 `root`）
- 密码 = `--admin-password` 传入的值

### 5.2 创建成员账号

**方式一：邀请码（推荐）**

```bash
# 在服务器上执行（admin 权限）
omnigent config members  # 或通过 Web UI: 设置 → 成员 → 邀请成员
```

**方式二：Web UI 管理**

1. 浏览器打开 `http://192.168.10.20:6767`
2. 设置 → 成员 → 邀请成员
3. 把邀请 URL 发给成员，成员注册后即可 login + host

### 5.3 成员接入流程

```bash
# 成员在自己的电脑上：
omnigent login http://192.168.10.20:6767    # 用注册的账号
omnigent host http://192.168.10.20:6767      # 注册自己的 host
```

---

## 6. 验证

### 6.1 服务器视角（需认证）

```bash
# 带 token 查询 host 列表
TOKEN=$(python3 -c "import json; d=json.load(open('$HOME/.omnigent/auth_tokens.json')); print([v['token'] for k,v in d.items() if '192.168.10.20' in k][0])")
curl -H "Authorization: Bearer $TOKEN" http://192.168.10.20:6767/v1/hosts
# 期望: 每个 host 一条记录, status=online
```

### 6.2 端到端会话测试

```bash
# 在任一台 host 上：
omnigent run --harness goose -p "用一句话回答：你是什么？"
# 期望: agent 在本机执行，结果返回
```

### 6.3 Web UI

浏览器打开 `http://192.168.10.20:6767` → 新建会话时**选择 host** → 会话在指定机器上运行。

---

## 7. 日常运维

| 操作 | 命令 |
|------|------|
| 查看 host 状态 | `omnigent host status` |
| 停止 host | `omnigent host stop` |
| 查看服务器日志 | `tail -f ~/.omnigent/logs/server/*.log` |
| 查看 host 日志 | `tail -f ~/.omnigent/logs/host/*.log` |
| 升级服务器 | `uv tool install --python 3.12 --force omnigent`（源码版用 git pull + 重装） |
| 升级 host | 同上，保持与服务器版本一致 |

---

## 8. 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| `Connection refused (HTTP 403)` | 版本不一致 | 服务器与 host `omnigent --version` 核对，统一版本 |
| 同上 | 单用户模式(AUTH_ENABLED=0) | 改用 accounts 模式（删掉 AUTH_ENABLED=0 重启） |
| 同上 | 未登录 | `omnigent login http://<server>:6767` |
| host 一直 `timed out during handshake` | 服务器 6767 防火墙未放行 | `firewall-cmd --permanent --add-port=6767/tcp` |
| 同上 | 网关/代理拦截 WebSocket | 放行或换同网段 |
| HTTP 200 但 WS 403 | WebSocket Upgrade 被中间层拦 | 检查网关/反向代理的 WS 支持 |
| `Auth required` | 未带 token 访问 API | 先 login，或用 Web UI |
| host 进程被杀 | 前台运行 + 终端关闭 | 用 `nohup` / systemd 后台运行 |

---

## 9. 安全建议

1. **修改默认 admin 密码**（部署后立即）
2. **成员用独立账号**，不共用 root
3. 服务器 6767 只对可信网段开放（防火墙 source 限制）
4. 定期 `omnigent upgrade` 保持版本 + 安全补丁
5. 敏感会话用策略限制（如 `ask_on_os_tools`、`cost_budget`）
6. 若跨公网，务必用 HTTPS/TLS（或 VPN/隧道），不要裸暴露 6767
