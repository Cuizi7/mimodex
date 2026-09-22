# mimodex

让 **Codex CLI** 用 **小米 MiMo** 后端跑，并且让 **auto-approve（Approve for me）真正生效**。

一个零依赖的本地适配代理 + 一个启动器。**不改写你的 `~/.codex/config.toml`** —— 普通 `codex` 与 ChatGPT 桌面 App 完全不受影响。

```
codex ──▶ mimodex proxy ──▶ MiMo 网关
             │
             ├─ ① model 别名        gpt-* / codex-auto-review → mimo-*
             ├─ ② 结构化输出降级     json_schema → json_object
             └─ ③ 推理档位 clamp     max/xhigh → high
```

---

## 它解决什么问题

Codex 从 2026 年 2 月起**彻底移除** `wire_api = "chat"`，只能走 Responses API（[Discussion #7782](https://github.com/openai/codex/discussions/7782)）。这让 MiMo 网关填不上三个坑：

### 1. 结构化输出缺失 → 越权操作被**拒绝**（最严重）

Codex 的 auto-review 由 guardian 子代理执行，其判定调用要求 **`json_schema` 结构化输出**。而 MiMo 的 `/responses` 只接受 `text` 与 `json_object`：

```
HTTP 400  responses_feature_not_supported:
text.format type 'json_schema' is not supported, only 'text' and 'json_object' are allowed.
```

失败姿态是 **fail-closed** —— 不是退回人工确认，而是直接判定「不可接受的风险」并拒绝执行：

```
This action was rejected due to unacceptable risk.
Reason: Automatic approval review failed: ...
```

结果：**所有越权命令全部被拒**，agent 只能困在沙箱里。

> 这也解释了为什么历史上把 `wire_api` 改成 `"chat"` 能让 auto-approve 工作 —— chat 路径上 Codex 发的是 `response_format`，而 MiMo **支持**它。chat 被移除后这条路就断了。本代理把这件事搬到 `responses` 路径上完成。

### 2. 模型名不被识别 → 子代理全军覆没

`~/.codex/agents/*.toml` 里写的是 `gpt-5.6-luna` / `gpt-5.6-terra` / `gpt-6-astra`。子代理继承会话的 provider，于是这些名字会被原样发给 MiMo：

```
HTTP 400  { "error": { "message": "Unsupported model gpt-5.6-terra" } }
```

### 3. 推理档位超出上限

agent 配置用了 `max` / `xhigh`，而 MiMo 只声明到 `high`。

---

## 为什么不用 cc-switch 之类

`farion1231/cc-switch` 确实内置了 Responses↔Chat 转换，但对这个场景**不适用**：

- 全仓库 `json_schema` 仅 3 处命中，且都在 Gemini 相关文件；`text.format` **0 处** —— 它的转换层**不处理结构化输出**，而这正是 auto-review 的硬需求
- 仓库里 `codex-auto-review` **0 处**命中 → 不会重写审查模型名
- 已有用户踩过并留了未修复的 issue：[#5774](https://github.com/farion1231/cc-switch/issues/5774)（正是 MiMo + json_schema 场景，原文称 "This causes **all** escalated commands in Codex to be automatically rejected"）、[#3670](https://github.com/farion1231/cc-switch/issues/3670)（`codex-auto-review` 被转发后被上游拒绝）、[#5903](https://github.com/farion1231/cc-switch/issues/5903)（请求模型重写功能尚不存在）

**本项目的取舍：只改请求体，绝不做协议翻译。** 完整翻译（SSE / tool call / reasoning / namespace）环节太多，任一环节出错都会变成难查的静默失败。mimodex 让 MiMo 原生讲 Responses 协议，只补它缺的那几个字段。

---

## 安装

```bash
git clone https://github.com/Cuizi7/mimodex.git
cd mimodex

bash install.sh                      # 交互式输入 MiMo API key
# 或
MIMO_API_KEY=tp-xxxx bash install.sh
```

安装脚本只做三件事：

1. 从 `config.example.json` 生成运行时 `config.json`
2. 把 API key 写到 `~/.codex/mimodex-token`（mode 600）
3. 把 `bin/mimodex` 链接到 `~/.local/bin/mimodex`

**它不碰 `~/.codex/config.toml`。**

### 还需要：MiMo 的模型目录

从[小米官方](https://mimo.xiaomi.com/)获取 MiMo 的 Codex 模型目录，放到 `~/.codex/model-catalog-mimo.json`，然后打补丁：

```bash
python3 tools/patch-catalog.py ~/.codex/model-catalog-mimo.json
```

补丁做三件事（幂等，自动备份）：

- 给所有条目补 `max` / `xhigh` 推理档位（让 Codex 接受 agent 配置里的档位）
- 把 `auto_review_model_override` 指向便宜快的模型（默认 `mimo-v2.6-flash`），避免用旗舰模型跑审查
- 添加 `gpt-5.6-luna` / `gpt-5.6-terra` / `gpt-5.6-sol` / `gpt-6-astra` 别名条目，各自克隆其映射目标的元数据

> 模型目录本身不入库 —— 那是小米的内容，且体积大。仓库只提供补丁脚本。

---

## 用法

```bash
mimodex                      # 启动 codex（MiMo 后端），参数与 codex 完全一致
mimodex exec "解释这个报错"    # 非交互
mimodex --help               # 透传给 codex

mimodex proxy start          # 启动适配代理（mimodex 会自动拉起，一般不用手动）
mimodex proxy stop|restart|status|logs [-f]|run

mimodex check                # 自检：node / codex / 目录 / 凭据 / 代理
```

子命令只占用了 `proxy` / `check` / `version` / `help`，其余一切原样透传给 `codex`。

---

## 隔离模型：为什么普通 codex 不受影响

**核心约定：`~/.codex/config.toml` 属于普通 `codex` 和 ChatGPT 桌面 App，mimodex 一概不写。**

| | 读到的配置 | 后端 |
|---|---|---|
| `codex` | `~/.codex/config.toml` | OpenAI |
| ChatGPT 桌面 App | 同上 | OpenAI |
| `mimodex` | 同上 + 运行时 `-c` 覆盖 | MiMo |

`mimodex` 把 `model` / `model_provider` / `model_catalog_json` / `web_search` / 整个 `[model_providers.mimo]` 块通过 codex 的 `-c` 在启动时注入。`-c` 是运行时覆盖，**不落盘**（已实测：一次完整 63k token 的会话前后，`config.toml` 字节完全一致）。

API key 经环境变量 `MIMO_API_KEY` 传给 codex（provider 用 `env_key` 引用），**不出现在 argv 里**，`ps` 看不到。

---

## 配置

`config.json`（从 `config.example.json` 生成，已被 `.gitignore`）：

```jsonc
{
  "port": 8787,
  "upstream": "https://token-plan-cn.xiaomimimo.com/v1",
  "model_map":       { "gpt-5.6-luna": "mimo-v2.6-flash", ... },  // 精确匹配优先
  "model_map_globs": { "gpt-*": "mimo-v2.6-pro" },                // 其次 glob
  "effort_map":      { "max": "high", "xhigh": "high", "minimal": "low" },
  "default_model": null                                            // 未命中则原样透传
}
```

匹配顺序：**精确 → glob → 原样透传**（`mimo-*` 自然通过）。

### 关于 effort：为什么只是 clamp，不是「预算换算」

GPT 侧的 reasoning effort 是**自适应**的，OpenAI 从不公布每档的固定 token 预算（[官方文档](https://developers.openai.com/api/docs/guides/reasoning)只说 "reasoning adaptively across reasoning efforts"；社区只有聚合倍数，如 GPT-5 `high` 比 `minimal` 多用 23× token）。**没有可对齐的预算数字，就不存在预算映射。**

所以这里只做序数 clamp：保证意图排序不丢失（max 意图 → MiMo 最高档），不假装等价。

实测数据点：responses 路径下 `effort=none` → `reasoning_tokens=0`（关断端确实生效）。

---

## 排查

代理日志是 JSONL，每请求一行（`proxy.log`）：

```json
{"ts":"...","path":"/v1/responses","origModel":"gpt-5.6-terra","model":"mimo-v2.6-flash",
 "fmtDowngrade":true,"effortIn":"max","effortOut":"high","stream":true,"status":200,"ms":1063}
```

| 字段 | 含义 |
|---|---|
| `origModel` → `model` | 别名是否命中；两者相同表示未映射（原样透传） |
| `fmtDowngrade` | 本次是否发生了 `json_schema` 降级（审查请求应为 `true`） |
| `effortIn` → `effortOut` | 档位是否被 clamp |
| `status` / `ms` | 上游状态码与耗时；499 = 客户端提前断开 |

**验证 auto-approve 是否真的在工作**：日志里应出现一条 `fmtDowngrade: true` 且 `status: 200` 的记录，对应一次越权操作。若看到 `status: 400` 且 message 提到 `json_schema`，说明降级没生效。

调试时 `DEBUG_DUMP=1 mimodex proxy run` 会把改写前后的完整 body 落到 `proxy.log.bodies`。

### 上下文窗口不对？

顶层 `model_context_window` 会**盖过** catalog 声明的值。mimodex 默认覆盖为 `1048576`（可用 `MIMODEX_CONTEXT_WINDOW` 改）。想确认实际生效的值——`codex` 不显示它，要看会话日志：

```bash
grep -o '"model_context_window":[0-9]*' ~/.codex/sessions/<日期>/<会话>.jsonl | head -1
```

---

## 已验证 / 未验证

**已端到端验证**（真实 MiMo + 真实 codex CLI 0.150.1）：

| 项 | 结果 |
|---|---|
| 沙箱外写入经 auto-review **真的执行** | ✅ 文件落盘，无驳回 |
| guardian 审查请求经代理降级 | ✅ 日志 `fmtDowngrade=true`, 200 |
| explorer 子代理 | ✅ `gpt-5.6-luna → mimo-v2.6-flash`，正常产出 |
| 审查判别力（真实接口实测） | ✅ 良性动作 `allow`；`~/.ssh`+`~/.aws` 外传判 `critical` + `deny` |
| 流式不缓冲 | ✅ 首字节 0.26s / 总耗时 2.3s，`response.completed` 正常到达 |
| 上游错误透传 | ✅ 收到 MiMo 原始 400 |
| `-c` 覆盖不落盘 | ✅ 完整会话前后 config.toml 字节一致 |

**未验证**：

- ChatGPT **桌面 App** 路径 —— 它用的是自带运行时（`0.155.0-alpha.9.2`），与 brew CLI 不是同一个东西。本项目的设计前提就是 App 继续走它自己的配置，所以这条不在范围内。
- MiMo 中间档位（low/medium/high）的实际 reasoning token 差异 —— 因 GPT 侧无可对齐预算，对比无意义，未深挖。

---

## 关键实现约束

改动代理前请先读 `AGENTS.md`。要点：

- **请求体可达 57KB+**，完整读取，勿设小上限
- **必须逐块透传 SSE**，不可缓冲；必须让上游的 `response.completed` 原样到达，否则 codex 报 `stream disconnected before completion`
- **失败会被 codex 重试 5 次**，代理必须无副作用
- **上游错误原样透传**状态码与 body —— 否则排查会退化成本项目最初遇到的那种「只报 `No such file or directory`，不说是哪个文件」的体验
- 允许 `JSON.parse` → `JSON.stringify`（完整保留未知字段）；**禁止**白名单式字段重建
- 不实现 WebSocket：自定义 provider 的 `supports_websockets` 默认关闭，实测 codex 对自定义 provider 只发 HTTP

---

## 卸载

```bash
rm -f ~/.local/bin/mimodex ~/.codex/mimodex-token
mimodex proxy stop 2>/dev/null || true
# 仓库目录直接删掉即可；~/.codex/config.toml 从未被本工具修改过
```

## License

MIT
