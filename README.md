# mimodex

在 Codex CLI 中使用小米 MiMo 后端，并恢复 auto-approve。

零依赖本地代理 + 启动器。不修改 `~/.codex/config.toml`，普通 `codex` 与 ChatGPT 桌面 App 不受影响。

## 背景

Codex 自 2026-02 移除 `wire_api = "chat"`，仅支持 Responses API（[Discussion #7782](https://github.com/openai/codex/discussions/7782)）。MiMo 网关的 Responses 实现缺少三项能力：

| 缺口 | 影响 |
| --- | --- |
| 不支持 `json_schema` 结构化输出 | auto-review 调用失败，且 fail-closed：越权命令被判为不可接受的风险直接拒绝，而非退回人工确认 |
| 不识别 `gpt-*` 模型名 | `~/.codex/agents/*.toml` 声明的模型全部返回 `400 Unsupported model` |
| 推理档位止于 `high` | agent 配置中的 `max` / `xhigh` 行为未定义 |

mimodex 在请求体层面补齐这三项，不涉及协议转换。

## 工作原理

```
codex ──▶ mimodex proxy (127.0.0.1:8787) ──▶ MiMo 网关
             │
             ├─ ① body.model                别名映射
             ├─ ② body.text.format.type     json_schema → json_object
             └─ ③ body.reasoning.effort     max / xhigh → high
```

响应按 SSE 逐块透传，不做改写。上游错误原样透传状态码与响应体。

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

补丁为所有条目补充 `max` / `xhigh` 档位、将 `auto_review_model_override` 指向成本更低的模型、并添加 `gpt-*` 别名条目。操作幂等且自动备份。

## 使用

```bash
mimodex                       # 启动 codex（MiMo 后端），参数与 codex 一致
mimodex exec "..."            # 非交互执行

mimodex proxy start           # 启动代理（mimodex 会在需要时自动拉起）
mimodex proxy stop | restart | status | logs [-f] | run

mimodex check                 # 环境自检
```

仅占用 `proxy` / `check` / `version` / `help` 四个子命令，其余参数原样透传给 `codex`。

## 配置隔离

mimodex 不写入 `~/.codex/config.toml`。MiMo 的 `model`、`model_provider`、`model_catalog_json` 及 provider 定义均通过 `codex -c` 在启动时注入，不落盘。

| 命令 | 后端 |
| --- | --- |
| `codex` / ChatGPT 桌面 App | 原有配置 |
| `mimodex` | MiMo |

API key 经环境变量 `MIMO_API_KEY` 传递（provider 以 `env_key` 引用），不出现在命令行参数中。

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

**确认 auto-approve 生效**：日志中应存在 `fmtDowngrade: true` 且 `status: 200` 的记录。若为 `400` 且消息含 `json_schema`，说明降级未生效。

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
