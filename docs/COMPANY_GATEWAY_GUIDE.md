# 公司统一模型网关接入指南（含 goose）

> 目标：让所有 agent（pi / goose / codex / claude-sdk）默认走**公司统一模型网关**，
> 个体 agent 可选择性使用私有模型。
> 前置：多机架构已部署，见 [`MULTI_MACHINE_DEPLOY.md`](MULTI_MACHINE_DEPLOY.md)。

## 1. Provider 的定义

**Provider = 公司统一的公共模型代理（model gateway）。**

- 所有 agent **默认共享**一个公共模型，由公司网关统一提供
  （统一鉴权 / 限流 / 审计 / 模型升级）。
- 每个 agent 无需各自配密钥 —— 走公司网关。
- **个体可选择性不使用公司模型**：
  - agent YAML 的 `executor.auth: {type: provider, name: <private>}`
  - 运行参数 `omnigent run --model <private>/<model>`

## 2. 支持矩阵（各 harness 如何走公司网关）

| harness | base_url 来源 | api_key 来源 | 状态 |
|---------|--------------|-------------|------|
| pi | Omnigent `providers:` | Omnigent secrets | ✅ 原生 |
| codex | Omnigent `providers:` | Omnigent secrets | ✅ 原生 |
| claude-sdk | Omnigent `providers:` | Omnigent secrets | ✅ 原生 |
| **goose** | goose `custom_providers/*.json` | **Omnigent 注入 env**（`GOOSE_API_KEY`）| ✅ 本分支已接线 |

> goose 的 base_url 定义在 goose 自己的配置（`custom_providers/*.json`），
> 但 **provider 选择**（`HARNESS_GOOSE_PROVIDER`）和 **api_key 注入**
> （`GOOSE_API_KEY`）由 Omnigent 驱动 —— 与 pi/codex 一致。

## 3. 配置步骤

### 3.1 协调服务器：配置公司网关 provider

```yaml
# ~/.omnigent/config.yaml
providers:
  company-gateway:              # 名字任意
    kind: gateway               # 或 key / local
    default: true               # ← 所有 agent 默认用它
    openai:
      base_url: https://company-gateway.example.com/v1
      api_key_ref: env:COMPANY_API_KEY   # 或内联 api_key
      models:
        default: company-model
```

- 也可用 Web UI：设置 → 模型提供商 → 新建提供商。
- `default: true` 让所有 harness 默认解析到它（`get_default_provider()`）。

### 3.2 每台 host：goose 的 custom provider 文件

goose 的 base_url 必须在每台 host 的 goose 配置里：

```bash
# 每台 host 执行一次：
mkdir -p ~/.config/goose/custom_providers
cat > ~/.config/goose/custom_providers/company.json <<'EOF'
{
  "name": "company",
  "engine": "openai",
  "display_name": "company-gateway",
  "description": "Company unified model gateway",
  "api_key_env": "GOOSE_API_KEY",
  "base_url": "https://company-gateway.example.com/v1",
  "models": [
    {
      "name": "company-model",
      "context_limit": 128000,
      "reasoning": false
    }
  ],
  "requires_auth": true,
  "supports_streaming": true
}
EOF

# 让 goose 默认用它：
goose configure   # 选择 company provider，或改 config.yaml：
# active_provider: company
```

> `api_key_env: GOOSE_API_KEY` —— 密钥由 Omnigent 在每次 spawn 时注入环境变量，
> **不写入 JSON 文件**（安全）。

### 3.3 生效验证

```bash
# 在任一 host 上跑一个 goose agent，确认走公司网关：
omnigent run --harness goose -p "只回复：我用的模型是？"
# 期望：goose 用 company provider（可看会话日志或模型响应）

# 无 provider 时验证本地配置保留：
# 删掉 config.yaml 的 providers 块 → goose 恢复用自己的 active_provider
```

## 4. 个体 agent 使用私有模型

```yaml
# agent.yaml 指定私有 provider（不走公司网关）
executor:
  auth:
    type: provider
    name: my-private        # 需在 providers: 里定义
```

```bash
# 或运行参数临时覆盖
omnigent run --harness pi --model my-private/other-model -p "..."
```

## 5. 优先级（代码确认）

```
spec.executor.auth（个体指定） > providers: default: true（公司网关） > ambient
```

- 个体 agent 明确指定 → 用指定的（私有）
- 未指定 → 默认走公司网关
- goose：无 provider / 无 default 时，**完全用自己配置**（行为不变）

## 6. 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| goose 401 | `GOOSE_API_KEY` 未注入或 key 错 | 检查 Omnigent secrets / providers api_key |
| goose 用错模型 | custom_providers JSON 模型名不符 | 检查 company.json 的 models[].name |
| goose 没走公司网关 | 未设 `default: true` 或 active_provider 没改 | 检查 config.yaml / goose configure |
| pi/codex 401 | providers key 与网关不匹配 | 用对应的网关 key（deepseek vs opencode 不同）|

## 7. 已实测（2026-08-03，本分支）

- pi 通过 Omnigent provider 调 api.deepseek.com → 「模型调用成功」
- goose 接线：有 provider 时注入 `HARNESS_GOOSE_PROVIDER=deepseek` + `GOOSE_API_KEY`；
  无 provider 时保持自己配置（两者均验证）
- 修复的坑：key 选择（deepseek vs opencode 两个 key）、模型名格式（不带前缀）
