# mimodex

在 Codex CLI 中使用小米 MiMo 后端。

零依赖本地代理 + 启动器。不修改 `~/.codex/config.toml`。

## 解决的问题

### 1. 支持 auto-approval

Codex 的 auto-review 由 guardian 子代理执行，其判定调用要求 `json_schema` 结构化输出。MiMo 的 Responses 端点只接受 `text` 与 `json_object`：

```
HTTP 400  responses_feature_not_supported:
text.format type 'json_schema' is not supported, only 'text' and 'json_object' are allowed.
```

而 Codex 在此处是 fail-closed —— 越权命令会被判为「不可接受的风险」直接拒绝，而不是退回人工确认：

```
This action was rejected due to unacceptable risk.
Reason: Automatic approval review failed: ...
```

结果是所有越权命令全部被拒，agent 只能困在沙箱内。代理将 `json_schema` 降级为 `json_object`，审查恢复正常。

### 2. 模型映射，无需修改 agents 配置

`~/.codex/agents/*.toml` 中声明的模型名（`gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-6-astra` 等）在 MiMo 上返回 `400 Unsupported model`，explorer / reviewer / implementer 等子代理无法启动。

代理在转发时按映射表改写模型名：

```
gpt-5.6-luna  → mimo-v2.6-flash
gpt-5.6-terra → mimo-v2.6-flash
gpt-6-astra   → mimo-v2.6-pro
```

因此 agents 配置无需改动，同一份定义可同时用于 OpenAI 与 MiMo 两套后端。

### 3. 配置隔离，可与 GPT 系列共用

mimodex 不写入 `~/.codex/config.toml`。MiMo 的模型、provider 与 catalog 配置通过 `codex -c` 在启动时注入，不落盘。

| 命令 | 后端 |
| --- | --- |
| `codex` / ChatGPT 桌面 App | 原有配置（GPT 系列） |
| `mimodex` | MiMo |

API key 经环境变量传递，不出现在命令行参数中。

## 原理

```
codex ──▶ mimodex proxy (127.0.0.1:8787) ──▶ MiMo 网关
             │
             ├─ ① body.model                别名映射
             ├─ ② body.text.format.type     json_schema → json_object
             └─ ③ body.reasoning.effort     max / xhigh → high
```

代理只改写请求体中的上述三个字段，响应按 SSE 逐块透传。上游错误原样透传状态码与响应体。

不做协议转换 —— MiMo 原生支持 Responses API，仅这三项存在差异。

## 安装

```bash
git clone https://github.com/Cuizi7/mimodex.git
cd mimodex
bash install.sh          # 交互式输入 MiMo API key
```

安装脚本会生成运行时 `config.json`、将 API key 写入 `~/.codex/mimodex-token`（mode 600）、链接 `bin/mimodex` 到 `~/.local/bin/`。

### 模型目录

从[小米官方](https://mimo.xiaomi.com/)获取 MiMo 的 Codex 模型目录，保存为 `~/.codex/model-catalog-mimo.json`，然后打补丁：

```bash
python3 tools/patch-catalog.py ~/.codex/model-catalog-mimo.json
```

补丁为所有条目补充 `max` / `xhigh` 推理档位、将审查模型指向成本更低的模型、并添加 `gpt-*` 别名条目。操作幂等且自动备份。

## 使用

```bash
mimodex                       # 启动 codex（MiMo 后端），参数与 codex 一致
mimodex exec "..."            # 非交互执行

mimodex proxy start           # 启动代理（mimodex 会在需要时自动拉起）
mimodex proxy stop | restart | status | logs [-f] | run

mimodex check                 # 环境自检
```

仅占用 `proxy` / `check` / `version` / `help` 四个子命令，其余参数原样透传给 `codex`。

## 配置项

`config.json`（由 `config.example.json` 生成）：

```jsonc
{
  "port": 8787,
  "upstream": "https://token-plan-cn.xiaomimimo.com/v1",
  "model_map":       { "gpt-5.6-luna": "mimo-v2.6-flash" },  // 精确匹配优先
  "model_map_globs": { "gpt-*": "mimo-v2.6-pro" },           // 其次 glob
  "effort_map":      { "max": "high", "xhigh": "high" },     // 序数 clamp
  "default_model": null                                       // 未命中则原样透传
}
```

`effort_map` 只做序数 clamp，不做 token 预算换算：GPT 的 reasoning effort 是自适应的，官方未公布每档固定预算，不存在可对齐的数值。

可通过环境变量覆盖：`MIMODEX_PORT`、`MIMODEX_MODEL`、`MIMODEX_TOKEN_FILE`、`MIMODEX_CATALOG`、`MIMODEX_CONTEXT_WINDOW`、`MIMODEX_AUTO_COMPACT`。

## 排查

代理日志为 JSONL，每请求一行：

```json
{"ts":"...","origModel":"gpt-5.6-terra","model":"mimo-v2.6-flash","fmtDowngrade":true,
 "effortIn":"max","effortOut":"high","stream":true,"status":200,"ms":1063}
```

| 字段 | 含义 |
| --- | --- |
| `origModel` → `model` | 别名映射结果；相同时表示未映射 |
| `fmtDowngrade` | 是否发生 `json_schema` 降级，审查请求应为 `true` |
| `effortIn` → `effortOut` | 档位 clamp 结果 |
| `status` / `ms` | 上游状态码与耗时（499 表示客户端提前断开） |

**确认 auto-approval 生效**：日志中应存在 `fmtDowngrade: true` 且 `status: 200` 的记录。若为 `400` 且消息含 `json_schema`，说明降级未生效。

**上下文窗口异常**：`model_context_window` 为顶层配置项，会覆盖模型目录中的声明值，mimodex 默认覆盖为 `1048576`。实际生效值只出现在会话日志中：

```bash
grep -o '"model_context_window":[0-9]*' ~/.codex/sessions/<date>/<session>.jsonl | head -1
```

调试时设置 `DEBUG_DUMP=1` 可将改写前后的完整请求体写入 `proxy.log.bodies`。

## 已知限制

- **ChatGPT 桌面 App 不在范围内**。它使用自带运行时，与 CLI 版本不同；本项目的前提是它继续使用原有配置。
- 不支持 WebSocket：`supports_websockets` 对自定义 provider 默认关闭，Codex 对该 provider 仅使用 HTTP。
- 模型目录不随仓库分发（属第三方内容），需自行获取后运行补丁脚本。

修改代码前请阅读 [`AGENTS.md`](AGENTS.md)，其中列出了硬性约束与验证方法。

## License

MIT
