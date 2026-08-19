# CacheGuard Architecture (Phase 1)

> Status: implemented · 2026-08-19
> Scope: **read-only cache observability for Claude Code**. No keepalive, no requests, no agent modification — by design, until Phase 2/3 are explicitly unlocked.

---

## 1. 定位与分期

```
看得见 (Observe)  →  算得清 (Calculate)  →  自动做 (Act)
Phase 1 ✅            Phase 2 (planned)      Phase 3 (planned)
Cache Monitor         Cost Engine            Auto Protect
```

Phase 1 只回答一个问题:

> **我们能否稳定地从真实 Claude Code session 中获取、解析、存储并展示 prompt cache telemetry?**

如果 Observation 不可靠, 后续一切都无意义。因此 Phase 1 的全部工程投入都在"事实的采集与诚实的推断"上。

## 2. 总体结构

```
┌─────────────────────────────────────────────────────────────┐
│                        CLI (commander)                       │
│   cacheguard status | watch | sessions | events | backfill  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                    SessionEngine
        (snapshot / watch / persist / events)
                           │
   ┌───────────┬───────────┼────────────┬──────────────┐
   ▼           ▼           ▼            ▼              ▼
AgentAdapter  Parser    JsonlTailer   Estimator    ProviderPolicy
(发现 session) (JSONL→   (增量 tail,   (状态机:      (TTL 来源:
 ClaudeCode    Observation) offset,    事实→推断)    STATIC/
              去重/容错)   半行缓冲)                 EMPIRICAL/…)
   │           │           │            │              │
   └───────────┴───────────┴──────┬─────┴──────────────┘
                                  ▼
                          CacheGuardStore (SQLite)
                    sessions / observations / cache_events
```

模块边界原则:

- **adapter 层**是唯一知道 Claude Code 细节的地方。`AgentAdapter` 接口 + 统一数据模型 (`src/types`) 使未来 CodexAdapter / CursorAdapter 不需要改动 core;
- **parser 是纯函数式**的: line in → `CacheObservation | null`, 无 I/O, 无状态 (除去重 set), 100% 可测;
- **estimator 不知道 Claude Code 存在**, 只消费 `CacheObservation`;
- **storage 只存 token 计数/时间戳/元数据**, schema 上不可能存 prompt 内容。

## 3. 数据流

### status (one-shot)

```
~/.claude/sessions/<pid>.json  ─┐
                                 ├→ discoverSessions() 按活跃度排序
~/.claude/projects/**/*.jsonl ─┘         │
                                  pick most recent session
                                         │
                        readTailSnapshot (最后 4MB, 行对齐, 不全量读)
                                         │
                         parseBuffer → dedupe(message.id) → observations
                                         │
                 merge(DB 已有) → persist (INSERT OR IGNORE)
                                         │
                    estimateCacheState(observations, baseUrlHint, now)
                                         │
                                   render / --json
```

### watch (live)

初始 snapshot 同上, 然后 `JsonlTailer` 从 EOF 增量 tail (fs.watch 唤醒 + 1s poll 兜底), 新增行走同一条 parse→persist→estimate 管线; 每秒基于内存 observations 重估 (TTL 倒计时随时间推进)。

## 4. 核心数据模型 (src/types)

```ts
CacheObservation {        // 一个 API 响应 = 一条事实
  timestamp, agent, sessionId, requestId(=message.id),
  model, inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens, contextTokens,   // context = in + read + write
  fiveMinuteCacheTokens, oneHourCacheTokens,
  partial, source, agentVersion
}

CacheFact { kind: HIT | MISS | PARTIAL_MISS, ... }     // telemetry 证明的事实
CacheStateEstimate { state, confidence, reason, ttl, ttlRemainingMs }  // 推断
```

## 5. Cache 状态模型 — 事实与推断严格分离

我们**观察不到 GPU 上的 KV cache**。能观察到的只有 telemetry。因此:

### 事实 (来自最近一次真实请求)

| Fact | 判定条件 | 说明 |
|---|---|---|
| `HIT` | `cache_read > 0` 且 ≥ 前一 context 的 50% | 大部分前缀命中 |
| `PARTIAL_MISS` | `cache_read > 0` 但 < 前一 context 的 50% | 部分命中 (分层 cache / 前缀断裂) |
| `MISS` | `cache_read = 0` 且 context ≥ 4096 | 全量重建 (可能伴随大量 cache write) |

### 推断 (事实 + 时间 + TTL policy)

```
                  ┌─ 事实发生 <10s ──── VERIFIED_HIT (事实窗口)
  lastFact=HIT ───┼─ 距估计 TTL 还有 >60s ── LIKELY_HOT   (confidence 随时间衰减)
                  ├─ 距估计 TTL 不足 60s ── AT_RISK
                  └─ 超过估计 TTL ─────── LIKELY_EXPIRED (措辞永远含 "No new request has verified")

  lastFact=MISS ──┬─ 且 cache_write=0 ─── VERIFIED_MISS (粘性, 直到下一个事实)
                  └─ 且 cache_write>0 ─── 重建即新缓存 → 进入 HOT 倒计时 (reason 说明)

  无信号 ─────────────────────────────── UNKNOWN
```

- 每个推断态都带 `confidence ∈ [0,1]` 和 `reason` (点名输入: 距上次事实多久、TTL 来源、读到了多少 token);
- confidence = 状态基础值 × 时间衰减 × policy 可靠性 (`0.5 + 0.5×reliability`);
- **任何代码路径都不允许把推断表述为事实** — UI 文案里 VERIFIED_* 只来自 telemetry。

## 6. ProviderPolicy — TTL 永不写死

```
resolveTtlPolicy(observations, baseUrl, model):
  1. RUNTIME_TELEMETRY    usage 中出现 ephemeral_1h_input_tokens > 0 → 1h regime
  2. STATIC_POLICY        endpoint 为 api.anthropic.com → 官方 5m (订阅下 Claude Code
                          实际请求 1h, 由规则 1 的 telemetry 证据覆盖)
  3. EMPIRICAL_ESTIMATE   本机历史观测的相邻请求对: 存活间隙 / 失效间隙
                          → ttlMs = maxSurvived × 0.8 (保守 haircut)
  4. UNKNOWN              网关且无证据 → 5m 占位, reliability 0.25, 明示"placeholder"
```

证据提取的防污染规则 (来自真实数据教训, 见 §8):

- 间隔 < 60s 的对**不作为证据** — 分钟级 TTL 之下, 亚分钟 miss 是前缀断裂 (后台 haiku 请求、tool result 插入), 不是过期;
- next.context < prev.context × 0.6 的 miss **不作为证据** — 那是 compaction/resume (前缀被替换);
- response 时间戳间隔 > 真实 idle (TTL 从请求开始算, 生成时间计入寿命) → survived gap 乘 0.8 haircut, 宁可早警告。

**本机现实**: 该环境 Claude Code 经 BigModel GLM 网关 (`open.bigmodel.cn/api/anthropic`) 运行。实测该网关 cache 存活可达 ~40min (远超 Anthropic 官方 5m), 且存在负载相关的逐出 (84s 即 miss 的观测)。这正是 policy 分层 + EMPIRICAL_ESTIMATE 存在的理由: **telemetry 优先于文档**。

## 7. 存储 (SQLite, `~/.cacheguard/cacheguard.db`)

```
sessions     (session_id PK, agent, project_dir, cwd, model, agent_version, started_at, last_seen)
observations (UNIQUE(session_id, request_id)  ← message.id 去重的持久化保证)
cache_events (SESSION_STARTED / VERIFIED_HIT / VERIFIED_MISS / PARTIAL_MISS / TTL_RISK)
```

- `INSERT OR IGNORE` + UNIQUE 约束 = 跨进程重启的幂等摄入; 事件只对**新插入**的 observation 发出 (重复 status 不会刷事件);
- TTL_RISK 为边沿触发 (状态进入 AT_RISK 时发一次)。

## 8. Parser 健壮性 (来自 schema 审计的强制要求)

审计发现 (docs/claude-code-schema.md):

1. **一个 API 响应 = 1~17 条 JSONL 记录** (每 content block 一条) → 必须按 `message.id` 去重, 否则统计放大 ~3x (实测 2548 条 → 885 响应);
2. `<synthetic>` 记录 usage 全 0 → 跳过;
3. 29/2548 条 usage 缺 cache 字段 → partial 标记, 不丢记录;
4. 时间戳非单调 (跨天 resume 交错) → 按 offset 读、按时间排;
5. 尾部半行 → tailer 缓冲至写完;
6. 未知 record type (v2.1.235 新增 queue-operation/atis-latch/…) → 计数跳过;
7. **官方文档明示 JSONL 是内部格式, 版本间会变** → parser 全面防御式 + 每条记录的 `version` 字段入库供漂移分析;
8. transcripts 按 `cleanupPeriodDays`(默认 30 天) 清理 → 存储层保留自己的历史, 不依赖 JSONL 长存。

## 9. Privacy — Local First

- 默认**零网络**。代码中没有 fetch/http 出站调用;
- 不读 `message.content`、不读 `history.jsonl` (含 prompt 正文)、settings.json 只提取 `ANTHROPIC_BASE_URL` 一个字段 (供 provider 判定; token 等字段代码路径上不存在);
- DB 只存计数器与元数据;
- README 明示: *CacheGuard does not upload your code or conversation content.*

## 10. 技术栈决策

**选择: TypeScript + Node.js (≥22.5) + better-sqlite3 + commander**

| 候选 | 评估 |
|---|---|
| **TypeScript ✅** | JSONL/动态 schema 解析最自然; node:fs + fs.watch 跨 Win/macOS/Linux; CLI 生态成熟; **未来 VS Code Extension 可直接复用 core 模块**; 本机 Node 24 已具备 |
| Rust | 单二进制分发好, 但 schema 高频漂移下迭代慢; watcher/SQLite/CLI 全套搭建成本高; 无法复用到 VS Code ext |
| Go | CLI 不错, 但动态 JSON 防御式解析别扭; SQLite 依赖 CGO (Windows 交叉编译痛); 无 VS Code 复用 |
| Python | 解析方便但 Windows 分发差 (uv 缓解但不如 node); 无 VS Code 复用 |

better-sqlite3: 同步 API 匹配低频写入负载, Windows 预编译二进制, 维护活跃。若未来原生依赖成为分发负担, 存储层接口化, 可平移到 node:sqlite (Node ≥22.5 内置)。

## 11. Phase 2/3 预留 (当前未实现)

- **Cost Engine**: 官方费率已调研 — cache read 0.1×、write 1.25×(5m)/2×(1h) 输入价; `Verified Saving` (真实 telemetry 支撑) 与 `Estimated Saving` (推断) 分账;
- **Auto Protect**: 决策式 `E(payoff) = P(return) × avoided_cold_cost − keepalive_cost`; keepalive 的实现载体 (SDK / statusline 联动 / proxy) 届时单独评审;
- **多 Agent**: `AgentAdapter` 已就位, 新增 adapter 不触碰 core;
- **OTEL 备选通道**: Claude Code 支持 OTEL 导出 (`claude_code.token.usage` 含 cacheRead/cacheCreation 维度; api_request log 事件含 request_id/duration_ms) — 比 JSONL 多了 latency 维度, Phase 2 诊断 cache miss 延迟代价时引入。

## 12. 已知的近似与诚实性声明

| 近似 | 方向 | 缓解 |
|---|---|---|
| response 间隔 ≈ idle 时间 | 高估 idle | survived gap ×0.8 haircut |
| TTL 是分布而非常数 (网关逐出) | 不可消除 | 状态永远 LIKELY_*, confidence 衰减, bounds 展示 |
| 并发请求 (sidechain/后台) 干扰相邻对 | 误判 miss | sidechain 排除 + 60s 证据下限 + compaction 检测 |
| snapshot 只读尾部 4MB | 早期观测缺失 | backfill 全量; DB 累积后无损失 |

---
*Phase 1 implemented 2026-08-19. Research sources for §6/§11: platform.claude.com prompt-caching docs, code.claude.com prompt-caching & monitoring docs (详见 development-plan.md 参考文献节)。*
