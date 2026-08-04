# 产品需求：模型提供商管理（自定义 Provider 配置界面）

> 状态：**已记录，待实现**
> 来源：多机部署实践（2026-08-03）中的需求痛点
> 分支：`remexs/zh-ui`（后续开发）

## 背景 / 痛点

Omnigent 底层引擎**支持**任意 OpenAI 兼容端点（`providers:` 块的 `key` /
`gateway` / `local` kind，可配 `base_url` + `models` + `wire_api`），但：

1. **没有可视化配置界面**——只能手写 `~/.omnigent/config.yaml` 的
   `providers:` 块，易错、不可见。
2. **`omnigent setup` 只引导预设 provider**（Anthropic / OpenAI /
   Databricks / Gemini），**不能引导自定义端点**（如 DeepSeek、OpenRouter、
   私有 vLLM、内网网关）。
3. 多 provider 管理无 UI，模型选择器 `/model` 可用但配置入口缺失。
4. 用户反馈："项目提供断点（provider）太少了，不能自己定义模型提供商，
   这个是需求痛点"。

## 目标

提供一个 **"模型提供商管理" 页面**（设置 → 模型提供商），可视化地：

- 添加自定义 provider：名称 + kind（key/gateway/local）+ base_url +
  API key（引用 env / 明文）+ 默认模型 + wire_api（chat/responses）
- 编辑 / 删除 provider
- 设为某 harness 的默认 provider
- 写回 `~/.omnigent/config.yaml` 的 `providers:` 块

## 改动范围（预估）

| 层 | 内容 |
|----|------|
| 前端 | 设置页新增 section + 表单/列表 UI（复用现有设置结构） |
| 后端 | 读写 `~/.omnigent/config.yaml` providers 的 REST API + 校验 |
| 语言 | 界面中文化（复用现有 i18n） |
| 引导 | （可选）`omnigent setup` 增加自定义端点选项 |

## 相关代码锚点

- Provider 解析：`omnigent/onboarding/provider_config.py`
  - `ProviderKind = Literal["key","subscription","gateway","local","databricks","cli-config","bedrock"]`
  - `ProviderEntry`（`kind`, `base_url`, `api_key_ref`, `models`, `wire_api`）
- 配置加载：`omnigent/runtime/workflow.py` 的 `_resolve_provider_for_build` /
  `default_provider_for_harness`
- 现有设置页：`web/src/pages/SettingsPage.tsx` + `web/src/shell/settingsNav.tsx`

## 验收标准

1. 页面能添加自定义 provider 并生效（pi/goose/codex 能通过它调模型）
2. 添加后 `/model` 可看到并切换该 provider 的模型
3. 配置持久化到 config.yaml，重启后仍在
4. 界面中文，符合现有风格


## Provider 的正式定义（2026-08-03 确认）

**Provider = 公司统一的公共模型代理（model gateway）。**

- 所有 agent（pi / goose / codex / claude-sdk）**默认共享**一个公共模型，
  由公司统一网关提供（统一鉴权 / 限流 / 审计 / 模型升级）。
- 每个 agent 无需各自配密钥 —— 走公司网关。
- **个体可选择性不使用公司模型**：
  - agent YAML 的 `executor.auth: {type: provider, name: <private>}`
  - 运行参数 `omnigent run --model <private>/<model>`

实现机制（`omnigent/onboarding/provider_config.py`）：
- `providers:` 块定义公共模型（`kind: key/gateway/local` + `base_url` + `api_key` + `models.default`）
- `default: true` → `get_default_provider()` → 所有 harness 默认解析到它
- 个体覆盖优先级：`spec.executor.auth` > 默认 provider > ambient

已实测（2026-08-03）：在协调服务器添加 deepseek provider（key 类型，
base_url=https://api.deepseek.com），本机 pi 被接管并通过该 provider
成功调用模型（「模型调用成功」）。修复了 key 用错（deepseek vs
opencode 两个 key）和模型名格式（不带 provider 前缀）两个坑。

## 备注

- 当前紧急优先级：先让 pi 用自己的 `~/.pi/agent` 配置跑通（见
  `docs/MULTI_MACHINE_DEPLOY.md`），此需求随后实现。
