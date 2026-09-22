# AGENTS.md

给在此仓库工作的 AI agent 的项目指南。**动手前请完整读完「硬性不变量」一节。**

---

## 这个项目是什么

一个本地 HTTP 适配代理 + 启动器，让 Codex CLI 能用小米 MiMo 后端跑，并让 Codex 的 auto-review（Approve for me）真正生效。

它存在的唯一原因：Codex 在 2026 年 2 月移除了 `wire_api = "chat"`，只保留 Responses API；而 MiMo 网关对 Responses API 的实现缺三样东西（`json_schema` 结构化输出、`gpt-*` 模型名、高于 `high` 的推理档位）。代理只**改写请求体里的三个字段**来补齐，不做任何协议翻译。

详细背景见 `README.md`。

---

## 硬性不变量

违反其中任何一条都会让项目失去价值，或造成难以排查的静默失败。

### 1. 绝不改写 `~/.codex/config.toml`

那是普通 `codex` 和 ChatGPT 桌面 App 的配置。mimodex 的一切都通过 codex 的 `-c` 在启动时注入。

- **禁止**在 `install.sh` / `bin/mimodex` 里对 `~/.codex/config.toml` 做任何写操作
- **禁止**把 `model_providers.mimo` 或 `model_catalog_json` 写进共享配置
- 唯一的例外是 `~/.codex/mimodex-token`（凭据，mode 600）和 `~/.codex/model-catalog-mimo.json`（用户自己放的模型目录）

验证方式：跑一次完整会话前后比对 `config.toml` 的 sha256，必须一致。

### 2. 绝不把密钥写进仓库

仓库是 **public**。API key 只能来自：

- 环境变量 `MIMO_API_KEY`，或
- `~/.codex/mimodex-token`（由安装脚本或用户创建，mode 600）

**禁止**在脚本、文档、示例、测试里硬编码任何 token。提交前必须跑一遍扫描：

```bash
grep -rniE 'tp-[a-z0-9]{20,}|sk-[a-z0-9]{20,}|bearer [a-z0-9]{20,}' --exclude-dir=.git .
```

`.gitignore` 已排除 `token` / `*.token` / `config.json` / `*.log` / `*.pid`，不要放宽。

### 3. 代理只改请求体，绝不做协议翻译

只允许这三处改写（都在 `proxy/proxy.mjs` 的 `rewrite()` 内）：

| # | 字段 | 规则 |
|---|---|---|
| ① | `body.model` | 精确 → glob → 原样透传 |
| ② | `body.text.format.type` | 仅当为 `json_schema` 时改为 `json_object`，保留 `text` 下其他键 |
| ③ | `body.reasoning.effort` | 按 `effort_map` clamp |

**禁止**触碰 SSE 事件结构、tool call、reasoning item、namespace。这些 MiMo 原生支持，任何「顺手修一下」都可能引入 cc-switch 那类难以定位的 bug（见 README 的相关 issue 链接）。

### 4. 不得缓冲 SSE

Codex 发 `stream: true` 并期望真正的增量 SSE。必须用 `pipeline(upstreamRes, res)` 逐块透传（`upstreamRes` 是 `https.request` 的 `IncomingMessage`），且必须让上游的 `response.completed` 原样到达。缓冲或截断会让 codex 报：

```
stream disconnected before completion: stream closed before response.completed
```

并触发 5 次重试。

### 5. 上游错误必须原样透传

状态码与 body 都要原样转发，不包装、不吞掉。这个项目本身就是从「报错只说 `No such file or directory` 却不说哪个文件」的痛苦里长出来的 —— 不要再制造同类体验。

### 6. 上游连接必须走显式 `https.Agent`，不要改回 `fetch`

**这是硬性约束，不是风格偏好。** 早期版本用全局 `fetch`（undici），在长驻进程里会塌缩到单条上游连接，所有请求串行排队。实测同一份请求的 6 并发总墙钟：直连 1.03s / 全新代理进程 1.03s / 劣化后的长驻进程 **37.6s**（采样期间上游 443 连接数恒为 `1`）。

改动转发层时：

- 用 `node:https.request` + 显式 `https.Agent`，保留 `maxSockets` / `keepAlive` / `timeout` 三项配置
- **保留 `sockWaitMs`、`connectMs`、`ttfbMs` 三个日志字段与 `/healthz` 的 `agent`/`metrics` 段** —— 它们是判断「代理慢还是上游慢」的唯一依据，没有它们这个故障只能靠猜
- 请求侧继续去掉 `accept-encoding`：`https.request` 不解压响应，保持正文未压缩最可预测
- 改完必须验证：6 并发墙钟应与直连同量级，且 `/healthz` 的 `queuedRequests` 保持 0

---

## 架构与文件

```
bin/mimodex            单一入口。无参数=启动 codex；proxy/check/version/help 为自定义子命令，其余透传
proxy/proxy.mjs        代理本体。零依赖，node:http + node:https（显式 Agent，见不变量 6）
config.example.json    运行时配置模板（config.json 由安装脚本生成，不入库）
install.sh             安装：生成配置 + 写凭据 + 链接命令 + 打模型目录补丁
tools/patch-catalog.py 模型目录补丁（幂等，自动备份）
```

**为什么入口要自己解析符号链接**：`~/.local/bin/mimodex` 是指向仓库内的符号链接，脚本用 `readlink` 循环解析出真实路径再推导 `ROOT`。macOS 的 `readlink` 不支持 `-f`，不要改用它。

**子命令命名空间**：只占用 `proxy` / `check` / `version` / `help`。codex 自身没有这几个子命令（它有 `doctor` 但没有 `check`），所以不会冲突。新增子命令前先核对 `codex --help` 的命令列表。

---

## 如何验证

改动后**必须**跑完下面这套。前四条不需要真实 API key 之外的额外条件。

### 决定性判据（少了这条等于没验证）

在 MiMo 会话里让 agent 写一个沙箱之外的路径，然后确认**操作真的执行了**：

```bash
mimodex exec "把 /tmp/mimodex-probe.txt 写成 hello（该路径在你的沙箱之外，需要提权）"
cat /tmp/mimodex-probe.txt   # 必须存在
```

同时代理日志里必须出现一条对应的审查请求：

```bash
mimodex proxy logs 20 | grep fmtDowngrade
# 期望：model 为便宜模型、status 200
```

若看到 `status: 400` 且 message 提到 `json_schema`，说明改写② 失效了 —— 这是本项目的核心功能，必须修好再提交。

### 其余检查

```bash
mimodex check                                    # 环境自检
curl -s localhost:8787/healthz                   # 代理探活
mimodex exec "say OK"                            # 端到端联通
```

- **子代理**：`mimodex exec "用 explorer 子代理列出当前目录文件"`，日志应出现 `gpt-5.6-luna → mimo-v2.6-flash`
- **流式**：`curl -N -w '首字节=%{time_starttransfer} 总耗时=%{time_total}\n' ... -d '{"stream":true,...}'`，首字节必须远小于总耗时
- **不落盘**：跑一次会话前后比对 `~/.codex/config.toml` 的 sha256

### 不要用桩服务器替代真接口

本项目所有结论都来自真实 MiMo 接口。桩可以用于探测**传输行为**（例如判断 codex 是否会发 WebSocket），但**不能**用于验证模型能力 —— 桩不会「判断」，也无法暴露 `json_schema` 这类平台差异。

---

## 已知陷阱

这些都是实际踩过的，改代码时留意。

**bash 中 `$VAR` 后紧跟非 ASCII 字符会被误解析。** 例如 `"...$TS（留档）"` 中的全角括号，bash 会把多字节首字节併进变量名，`set -u` 直接报 `unbound variable`。**紧邻中文时一律写 `${VAR}`。**

> 注：本节上面那行刻意保留了错误写法作为反面示例，因此对 `AGENTS.md` 做 `$VAR` 扫描时会出现一条预期内的命中；扫描真实代码时请排除本文件。

**配置与日志的查找路径要与目录布局一致。** 仓库布局是 `proxy/proxy.mjs` + 根目录 `config.json`，而代理默认按 `__dirname` 找配置 —— 只认 `__dirname` 会让 clone 下来的用户**直接启动失败**（本地测试若把两者放同一目录就发现不了）。查找顺序是：`MIMO_PROXY_CONFIG` → CWD → `__dirname` → `__dirname/..`；日志默认与配置同目录。`bin/mimodex` 启动代理时显式传入这两个路径。

**Codex 会把顶层 `model_context_window` 当作对 catalog 的覆盖。** 共享配置里的值会盖过模型目录声明的上下文窗口，所以 `bin/mimodex` 必须显式覆盖它，否则窗口会静默沿用旧值。这个数在 codex UI 里看不到，只能从会话日志的 `token_count` 事件读。

**`-c` 覆盖不会落盘，但 codex 仍会重写 `config.toml`。** 会话结束时它可能把文件重写一遍（落盘 `[projects.*]` / `[hooks.state.*]` 等它自己管理的条目）。内容通常不变，但这就意味着**外部工具（如桌面 App）也能通过这条通路写入 `model`** —— 排查「配置莫名被改」时别只怀疑 mimodex。

**桌面 App 与 CLI 是两个运行时。** App 用自带的 codex（版本与 brew CLI 不同），且会缓存模型列表。如果曾把共享配置短暂指向 MiMo，App 可能缓存下 `mimo-*` 模型并在之后写回配置，造成 `model` 有值但 `model_providers.mimo` 缺失的坏状态。**不要试图让 App 也走 MiMo** —— 那需要把 provider 写进共享配置，直接违反不变量 1。

**`auto_review_model_override` 是模型目录里的字段，不是 `config.toml` 的键。** 另有一个 `review_model` 键，但它只作用于 `/review` 功能，**对 auto-approve 无效** —— 这是个容易踩的坑。

**不要用 `approval_policy = "never"` 来「解决」审查问题。** auto-review 只在有交互式审批时才有意义；`never` 会让越权动作直接失败而不是被审查放行，语义完全不同。

---

## 代码约定

- 代理保持**单文件、零运行时依赖**（只用 node 内置模块）。不要引入 npm 包。
- 日志保持 **JSONL，每请求一行**，字段名沿用现有约定（`origModel` / `model` / `fmtDowngrade` / `effortIn` / `effortOut` / `status` / `ms`）。这些字段是排查的唯一抓手，不要改名。
- shell 脚本统一 `set -euo pipefail`，对外用 `die` / `note` 输出。
- Python 脚本（`tools/`）用标准库、带 `argparse`、幂等、写前备份。
- 注释与文档用中文，代码标识符用英文。
- 提交信息用祈使句，说明**为什么**而不只是做了什么。
