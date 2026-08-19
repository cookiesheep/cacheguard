# CacheGuard

> **让 Coding Agent 的 Prompt Cache 看得见、算得清、自动保护。**
> Read-only prompt-cache observability for coding agents.

```
$ cacheguard status

CacheGuard — read-only cache observability

Agent          Claude Code 2.1.235
Session        ae6bfb8b-e5c4-4f76-824d-17347c5bef80
Project        D:\code\build-your-own-claude-code
Model          glm-5.3

Context        132,004 tok
Cache Read     128,576 tok
Cache Write         0 tok
Cache Ratio      97.4%

Last Call      2h27m ago
Last Cache     2h27m ago (verified hit: 128,576 tok)
TTL Remaining  expired (est.) [EMPIRICAL_ESTIMATE]

Cache State    LIKELY_EXPIRED
Confidence     77%

Reason: Last verified cache hit 2h27m (128,576 tokens read), 2h27m ago —
beyond the estimated TTL (EMPIRICAL_ESTIMATE: 1943s). No new request has
verified either way.
```

## 为什么

LLM 服务商用 Prompt Cache / Prefix Cache 避免每轮重新 prefill 全部历史。但 cache 有 TTL 与逐出策略 — **你在 Agent 完成任务后阅读代码、思考的每一分钟, 都在消耗 cache 的寿命**。下次输入时大段前缀重新 prefill: 更贵、更慢, 而这一切对用户完全不可见。

TraceLab (arXiv 2606.30560) 对真实 Claude Code/Codex 工作负载的测量: prefix cache 总命中率 95.7%, 但**新用户消息轮只有 86.9%** (Claude 口径; Claude+Codex 合计 84.4%, Codex 78.2%); 追加 token 中 **81% 是冗余 re-prefill**, prefill amplification 达 **5.3×** (Claude 8.1×); 人类平均响应间隔 46.7 分钟 — 远超常见 5 分钟 TTL。

CacheGuard 把这个过程变成看得见的: 当前 context 多大、命中了多少、cache 大概率还活着吗、什么时候过期、依据是什么。

## 诚实性原则 (这个工具的底线)

我们**观察不到 GPU 上的 KV cache** — 只有 telemetry。因此:

- **`VERIFIED_HIT` / `VERIFIED_MISS`** 只在真实请求的 usage 证明时出现 (事实);
- **`LIKELY_HOT` / `AT_RISK` / `LIKELY_EXPIRED`** 是推断, 永远带 confidence 和可读的 reason (推断);
- 不知道就显示 `UNKNOWN`, TTL 来源不明就标注 `UNKNOWN (placeholder)`;
- **事实与推断绝不混同**。UI 上的每个字都能回答"你怎么知道的"。

## 安装与使用

要求: Node.js ≥ 22.5, 已使用过 Claude Code (`~/.claude/projects` 有数据)。

```bash
npm install -g .        # 从源码安装 (cacheguard 命令)

cacheguard status       # 一次性的 cache 状态面板 (默认最近活跃 session)
cacheguard watch        # 实时刷新 (TTL 倒计时随时间推进)
cacheguard sessions     # 列出发现的 session
cacheguard events       # cache 事件历史 (VERIFIED_MISS / PARTIAL_MISS / TTL_RISK …)
cacheguard backfill <id> # 全量解析一个 session 入库
cacheguard status --json # 机器可读输出
```

数据存于本地 `~/.cacheguard/cacheguard.db` (SQLite) — Claude Code 的 JSONL 约 30 天会被清理, CacheGuard 保留自己的历史。

## 工作原理

```
~/.claude/sessions/<pid>.json        ← 活跃 session 注册表 (识别当前 session)
~/.claude/projects/**/<sessionId>.jsonl ← assistant 记录的 message.usage
                                         (cache_read / cache_creation / ephemeral_5m / 1h …)
```

- **增量 tail** (offset checkpoint + 半行缓冲 + 截断检测), 46MB session 只读尾部 4MB 即可出状态, 正常运行时对 Claude Code **无可感知影响**;
- **message.id 去重** — 一个 API 响应在 JSONL 里是 1~17 条记录 (实测放大 ~3x), 这是准确统计的前提;
- **TTL 不写死**: `STATIC_POLICY` (官方文档) → `RUNTIME_TELEMETRY` (ephemeral_1h 证据) → `EMPIRICAL_ESTIMATE` (本机观测的存活/失效间隙, 含防污染规则) → `UNKNOWN`。经网关 (BigModel/OpenRouter/…) 运行时, 静态策略自动失效, 以本机证据为准。

架构详见 [docs/architecture.md](docs/architecture.md), Claude Code 数据格式审计见 [docs/claude-code-schema.md](docs/claude-code-schema.md)。

## Privacy

**CacheGuard does not upload your code or conversation content.**

- 零网络请求 — 代码中不存在任何出站 HTTP;
- 只读取 token 计数、时间戳、模型名、session 元数据; 不解析、不存储任何 prompt/代码/对话内容;
- `~/.claude/history.jsonl` (含输入正文) 不读取; `settings.json` 只提取 `ANTHROPIC_BASE_URL` 一个字段用于判定 provider。

## 只读承诺 (Phase 1)

Phase 1 **不做**也不会做: keepalive ping、模拟输入、修改 session、隐藏消息、API proxy。仅当 Observe 与 Cost Engine 被验证可靠后, Phase 3 的 Auto Protect 才会以显式 opt-in 的方式引入。

## Roadmap

| Phase | 能力 | 状态 |
|---|---|---|
| 1 | Cache Monitor (看得见) | ✅ 本仓库 |
| 1.5 | 受控 idle-time 实验 (验证 TTL 行为) | 进行中 |
| 2 | Cost Engine (算得清) — Verified vs Estimated Saving 分账 | 计划 |
| 3 | Auto Protect (自动做) — 期望收益决策式 keepalive | 计划 |
| — | 多 Agent: Codex / Cursor / OpenCode adapters (接口已就位) | 计划 |

## Development

```bash
npm install
npm test          # 36 tests (parser robustness / state machine / policy / tailer / storage)
npm run build
npm run schema-audit   # 重新审计本机 Claude Code JSONL schema
```

工程日志: [docs/development-plan.md](docs/development-plan.md) — 每阶段记录已完成 / 当前事实 / 发现的问题 / 未验证假设 / 下一步。

## License

Apache-2.0
