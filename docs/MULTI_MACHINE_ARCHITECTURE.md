# Omnigent 多机协作架构

> 架构说明：一台协调服务器 + 多台开发机器（host）的部署拓扑。
> 配套部署文档见 [`docs/MULTI_MACHINE_DEPLOY.md`](MULTI_MACHINE_DEPLOY.md)。

## 1. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    协调服务器 (Coordinator Server)                │
│                    192.168.10.20 (accounts 模式)                 │
│                                                                  │
│  ┌─────────────┐   ┌─────────────┐   ┌──────────────────────┐   │
│  │  控制平面     │   │  状态存储    │   │   认证/授权           │   │
│  │ 会话编排      │   │ sqlite DB   │   │   admin + 成员账号    │   │
│  │ 策略/审批     │   │ artifacts   │   │   JWT session        │   │
│  │ host 注册表   │   │             │   │                      │   │
│  └─────────────┘   └─────────────┘   └──────────────────────┘   │
└───────────────┬────────────────────────────────┬────────────────┘
                │ host 隧道 (WebSocket /v1/hosts/..) │
                ▼                                ▼
     ┌────────────────────┐        ┌────────────────────┐
     │ 开发笔记本 A (host)  │        │ 开发笔记本 B (host)  │
     │ 192.168.20.30       │        │ 其他成员            │
     │ name: remexs        │        │                    │
     │ owner: root         │        │                    │
     │                     │        │                    │
     │ harnesses:          │        │ harnesses:         │
     │  ├ goose ✅         │        │  ├ ...             │
     │  ├ pi (需配置)       │        │  └ ...             │
     │  └ opencode (待装)   │        │                    │
     │                     │        │                    │
     │  ┌───────────────┐  │        │  ┌───────────────┐  │
     │  │ runner 进程    │  │        │  │ runner 进程    │  │
     │  │ 执行 agent     │  │        │  │ 执行 agent     │  │
     │  └───────────────┘  │        │  └───────────────┘  │
     └────────────────────┘        └────────────────────┘
```

## 2. 角色划分

| 角色 | 机器 | 职责 |
|------|------|------|
| **协调服务器** | 192.168.10.20（麒麟 Linux） | 会话编排、状态存储、认证、策略审批、host 注册表。**不执行 agent** |
| **Host（开发笔记本）** | 192.168.20.30 等 | 运行 agent（runner 进程）。每台机器注册为独立 host，可带不同 harness |

## 3. 关键机制

### 3.1 Host 注册（单向隧道）

每台开发机器执行：

```bash
omnigent host http://<协调服务器>:6767
```

host 与服务器建立 **WebSocket 隧道**（`/v1/hosts/{host_id}/tunnel`），之后：
- host 主动维持连接（断线自动重连）
- 服务器通过隧道向 host 派发会话
- host 上报其可用的 harness 列表（`configured_harnesses`）

### 3.2 认证模型（accounts 模式）

协调服务器绑定非 loopback 地址时**自动启用 accounts 模式**（防止未授权访问）：

```
服务器绑定 0.0.0.0  →  OMNIGENT_AUTH_ENABLED 自动置 1  →  需要登录
```

- **admin**：第一个账号（默认用户名 = 服务器 OS 用户），通过 `--admin-password` 或首次网页引导创建
- **成员**：admin 通过邀请码（invite token）创建，每个开发者独立账号
- **认证协议**：`omnigent login <server_url>` → POST `/auth/login` → 存储 JWT 到 `~/.omnigent/auth_tokens.json`

### 3.3 会话执行位置

```
协调服务器              开发笔记本
  编排会话  ──派发──▶    runner 执行 agent
  状态存储               本地文件/Shell 操作
  策略/审批              工具调用
```

- 服务器是**控制平面**，不跑 harness
- agent 永远在 **host 机器**上执行
- 一个编排 agent 可以 `sys_session_send` 派发子任务到**指定 host**（多机并行）

### 3.4 策略与审批（跨机器生效）

- **服务器级策略**：作用于所有 host 上的会话
- **agent spec 策略**：作用于该 agent 的所有会话
- **会话级策略**：运行时临时添加
- 审批（ASK）在**触发它的会话**所在机器呈现（网页/终端）

## 4. 网络要求

| 通道 | 端口 | 方向 | 说明 |
|------|------|------|------|
| SSH | 22 | 双向 | 管理通道（安装/维护） |
| HTTP API | 6767 | host → 服务器 | REST + WebSocket 隧道 |
| WebSocket | 6767 | host → 服务器 | host 隧道（必须可达） |

**关键约束**：
- 协调服务器的 6767 必须对所有 host 可达（防火墙放行）
- host 只需**主动出站**连服务器（不需要入站端口）
- WebSocket Upgrade 必须不被中间防火墙/代理拦截

## 5. 已实测验证（2026-08-03）

| 验证项 | 结果 |
|--------|------|
| 远程服务器部署（0.8.0.dev0） | ✅ |
| 远程防火墙放行 6767 | ✅ |
| 本机 `omnigent login` 认证 | ✅ Logged in as root |
| 本机 host 注册到远程 | ✅ ✓ Connected as 'remexs' |
| 远程确认 host online | ✅ owner=root, status=online |
| HTTP API 双向通 | ✅ |
| 本机 goose 实测跑会话 | ✅ |

## 6. 扩展：加入新开发人员

1. 安装 omnigent（Python 3.12）：`uv tool install --python 3.12 omnigent`
2. 登录：`omnigent login http://192.168.10.20:6767`（admin 先创建账号/邀请码）
3. 注册 host：`omnigent host http://192.168.10.20:6767`
4. 配置该机器的 harness（安装 goose/pi/opencode 等并配置凭证）
5. 验证：协调服务器 `/v1/hosts` 出现新 host

## 7. 备选拓扑

- **单机模式**：一台机器同时跑 server + host（开发调试）
- **云沙箱 host**：host 运行在 Modal/Daytona/E2B 等云沙箱（无笔记本也能跑 agent）
- **Databricks 托管**：使用 Databricks 部署的 Omnigent（免自建服务器）
