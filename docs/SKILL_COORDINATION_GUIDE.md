# Skill 协调层接入指南（SkillHub 集成）

> 目标：Omnigent **不托管技能内容**——技能从 SkillHub 注册中心下载，
> Omnigent 只做**协调 + 记录**（安装到哪个 agent / 全局、版本、来源）。
> 个人电脑与协调服务器均安装 skillhub CLI，使用**同一套 admin token**。

## 1. 架构

```
┌──────────────────────────────────────────────────────────┐
│  SkillHub (如 http://192.168.10.86:4011) — 技能内容中心    │
│  存储技能内容/版本 · resolve/download 免认证               │
└───────────┬──────────────────────────────────────────────┘
            │  ① 本机 CLI 直接安装（个人 harness）
            │  ② 协调服务器转发安装（omnigent skill install）
            ▼
┌──────────────────────┐      ┌──────────────────────────┐
│  个人电脑（本机 host） │      │  协调服务器 (192.168.10.20)│
│  skillhub CLI + token│      │  skillhub CLI + token    │
│  ~/.agents/skills/   │      │  /root/.agents/skills/   │
│  ~/.claude/skills/   │      │  + /v1/skills 协调 API    │
└──────────────────────┘      └──────────────────────────┘
```

- **内容**：永远在 SkillHub（下载 ZIP，含 `SKILL.md` + 资源文件）。
- **安装动作**：本机用户自己装（skillhub CLI），或通过 Omnigent 服务器转发装。
- **记录**：Omnigent 服务器存 `installed_skills` 记录（slug/版本/绑定 agent/时间），
  不存技能内容本身。

## 2. 前置：安装 skillhub CLI + 登录

> 服务器（RHEL 系）需先装 npm：`dnf install -y npm`

```bash
# 本机 + 服务器都装
npm install -g @astron-team/skillhub@0.1.9

# 登录（CLI 与 API 使用同一套访问凭证，通用）
skillhub login --registry http://192.168.10.86:4011 --token sk_xxxx
# → Logged in as docker-admin (SUPER_ADMIN 最高权限)

# 验证
skillhub whoami --registry http://192.168.10.86:4011
```

> **重要**：skillhub CLI 与 API 使用**同一套 token**（通用访问凭证），
> **无需**为 CLI 开通额外权限。

## 3. CLI 直接安装（个人电脑 / 服务器通用）

```bash
# ⚠️ 正确用法：--namespace 显式指定，slug 不带前缀！
skillhub install ssh-server-ops --namespace cwr \
  --registry http://192.168.10.86:4011 --scope user --force

# 装到指定 agent profile（如 claude-code / codex / openclaw …）
skillhub install ssh-server-ops --namespace cwr \
  --registry http://192.168.10.86:4011 --agent claude-code --force

# 列出 / 卸载
skillhub list --registry http://192.168.10.86:4011
skillhub remove ssh-server-ops --namespace cwr --registry http://192.168.10.86:4011
```

> **坑**：slugs 形如 `cwr/ssh-server-ops`（namespace--name），CLI 的
> `--namespace` **默认是 `global`**。若直接传 `cwr/ssh-server-ops`，
> 会拼成 `global/cwr/ssh-server-ops` → 403 `access denied`。
> 必须 `--namespace cwr` + slug 只写 `ssh-server-ops`。

**默认安装目录**：
| scope | 目录 |
|-------|------|
| `--scope user` | `~/.agents/skills/<name>/`（及各类 agent profile 目录）|
| `--scope project` | `<cwd>/.agents/skills/<name>/` |
| `--agent <profile>` | `~/.<profile>/skills/<name>/`（如 `~/.claude/skills/`）|

## 4. Omnigent 协调层（服务器转发安装）

Omnigent 提供 `omnigent skill` 命令组，通过服务器 API 协调安装——
适合"给指定角色 agent（architect/backend/...）装技能"。

```bash
# 先登录 Omnigent 服务器（accounts 模式）
omnigent login http://192.168.10.20:6767   # 输入 admin/admin123!

# 列出已安装
omnigent skill list

# 安装到指定角色 agent（物化到 agent bundle skills/ 目录）
omnigent skill install cwr/ssh-server-ops --agent backend

# 全局安装（所有 agent 可见）
omnigent skill install cwr/ssh-server-ops

# 卸载
omnigent skill remove cwr/ssh-server-ops --agent backend
```

**服务器 API**：
| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/skills` | GET | 列出已安装技能记录 |
| `/v1/skills/install` | POST | `{slug, agent?, registry?}` 下载 ZIP → 物化 + 记录 |
| `/v1/skills/remove` | POST | `{slug, agent?}` 删除物化目录 + 记录 |

**物化目标**（服务器上）：
| 场景 | 目录 |
|------|------|
| `--agent backend` | `/root/.omnigent/agents/backend/skills/<name>/` |
| 全局（无 agent） | `/root/.omnigent/skills/<name>/` |

> 物化到 agent bundle 的 `skills/` 后，harness 启动时自动发现
> （`_discover_skills(root / "skills")`），**零运行时改动**。
> 需重启服务器让 agent 重新加载新技能。

**记录文件**：`~/.omnigent/skills.yaml`
```yaml
installed:
- slug: cwr/ssh-server-ops
  name: ssh-server-ops
  version: latest
  agent: backend
  registry: http://192.168.10.86:4011
  target: /root/.omnigent/agents/backend/skills/ssh-server-ops
  installed_at: '...'
```

## 5. 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `access denied — token may lack required scope` | slug 带前缀 + 默认 namespace=global | `--namespace cwr` + slug 不带前缀 |
| `authentication failed` | 未登录 / token 无效 | `skillhub login --token sk_xxx` |
| agent 看不到新装技能 | 服务器启动时快照 | 重启服务器（`start-server.sh`）|
| 服务器无 npm | RHEL 系 | `dnf install -y npm` |

## 6. 参考

- 协调层代码：`omnigent/server/routes/skills.py`、`omnigent/cli.py`（`skill` 命令组）
- SkillHub CLI：`@astron-team/skillhub`（iflytek 发布，Apache-2.0）
