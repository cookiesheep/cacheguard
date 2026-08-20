# Codex CLI 本地数据 Schema 审计

> **验证状态: 本机真实数据已验证** (codex-cli 0.147.0 / 历史 session 0.146-alpha, Windows, `~/.codex`, 2026-08-20 审计; 共扫描 2026-03 ~ 2026-08 的真实 rollout, 模型覆盖 gpt-5.4 / gpt-5.6-sol / gpt-5.6-luna)。
> 无官方格式文档; 事实标准是 openai/codex 源码 serde 定义 (`codex-rs/protocol/src/protocol.rs`、`codex-rs/rollout/`)。本地观察与 serde 定义一致处标注 [实测]。

---

## 1. 数据在哪里

| 路径 (相对 `~/.codex/`, `$CODEX_HOME` 可覆盖) | 说明 |
|---|---|
| `sessions/YYYY/MM/DD/rollout-<ts>-<conversation_id>.jsonl` | **session 主文件, 按日期嵌套** [实测] (非扁平) |
| `archived_sessions/rollout-*.jsonl` | 归档 [实测] |
| `session_index.jsonl` | 会话索引 (未采用; 发现走递归扫描) |
| 部分部署 | rollout 可能被 **zstd 压缩** (`.zst` 或 magic `28 B5 2F FD`) — CacheGuard 跳过并计数, 不解压 [本机未见, 按规范防御] |

`<conversation_id>` 是文件名里的 UUID; 与 `session_meta.payload.id` 一致 [实测]。

## 2. 行格式

每行 `{timestamp, type, payload}` [实测]。**`ordinal` 字段在 0.147 数据中全部缺失** (593/593 无 ordinal) — 不要依赖它做去重键。

### 2.1 实测 record type 分布 (0.147, 单文件 3227 行)

| type | 频率 | 对 CacheGuard |
|---|---|---|
| `session_meta` | 1/文件 | **ambient**: id / cli_version / model_provider / cwd (无 model 字段!) |
| `turn_context` | 每轮 | **ambient**: `payload.model` (模型名的唯一来源); 另有 effort/comp_hash |
| `event_msg/token_count` | 每请求 ~1 个 | ⭐ **cache telemetry 唯一来源** (§3) |
| `response_item/*`, `world_state`, `compacted`, `event_msg/<其他>` | 大量 | 跳过 (含对话正文 — 不读取) |
| `event_msg/context_compacted` | compaction 时 | 跳过; compaction 防护靠 context 骤降检测 (与 Claude Code 共用规则) |

## 3. token_count 结构 [实测]

```json
{
  "timestamp": "2026-08-07T10:26:33.162Z", "type": "event_msg",
  "payload": { "type": "token_count", "info": {
    "last_token_usage": {
      "input_tokens": 30399, "cached_input_tokens": 8960,
      "cache_write_input_tokens": 0,
      "output_tokens": 483, "reasoning_output_tokens": 306, "total_tokens": 30882
    },
    "total_token_usage": { ...同结构累计... },
    "model_context_window": 200000
  }}
}
```

- `info` **可为 null** (实测 2026-03/04 文件各 1 例) → 跳过并计数;
- `rate_limits` 本机数据未出现 (字段存在与否随版本/提供商);
- 采用 `last_token_usage` (单请求口径); `total_token_usage` 是会话累计, 不用于 per-request 观测;
- 一个 token_count ≈ 一次 API 请求 (工具循环内逐请求触发; 实测 593 事件/25 任务, 上下文单调递增)。

## 4. ⚠️ 与 Claude Code 的口径差异 (核心)

### 4.1 context 推导 — 两家语义相反 [实测验证]

| | Claude Code (Anthropic) | Codex (OpenAI) |
|---|---|---|
| `input_tokens` | **不含** cached 部分 | **已包含** cached (`total = input + output` 精确成立, 实测 30,399+483=30,882) |
| contextTokens | `in + cache_read + cache_write` | **`= input_tokens`** (cached 是子集, 不加) |
| cache ratio | `cr / (in+cr+cc)` | `cached / input` |

Parser 按各自约定计算 `contextTokens`; estimator/evidence 的比值逻辑两家通用。

### 4.2 去重键

- Claude Code: `message.id` (一响应多记录, ~3× 放大);
- Codex: **无 message.id, ordinal 缺失**; token_count 基本按请求计。requestId = `tc:<timestamp>:<input_tokens>` (ms 时间戳 + 输入量; 跨重解析稳定, 文档化于 parser)。

### 4.3 cache_write 的"未知"语义 (强制要求, 已实现)

- **pre-GPT-5.6 模型**: serde `#[serde(default)]` 使字段缺省 0 — 无法区分 "没写" 与 "不支持" → `cacheWriteUnknown=true`, 0 不作为事实;
- **GPT-5.6+**: 字段语义可用 (`cacheWriteUnknown=false`); 但本机 gpt-5.6-sol/luna 经 custom provider **cache_write 恒 0 而缓存明确在增长** (cached 跨请求 +20k) — 即便新模型, custom provider 下 0 也不可信, 已作为已知局限记录 (parser 只按字段存在性+模型代际打标, 不猜测 provider 行为);
- `rate_limits` 额度快照本机未见, 未实现。

### 4.4 活跃 session 识别

Codex **无** Claude Code 式 `sessions/<pid>.json` 注册表 → 只有文件 mtime 一个信号。`session_meta.payload.model_provider` 可判 custom/openai (影响 policy 置信注记)。

## 5. TTL Policy (src/policy/provider-policy.ts codex 分支)

| 模型 | 策略 | 依据 |
|---|---|---|
| GPT-5.6+ (`gpt-5.6*`/`5.7+`/`gpt-6+`) | STATIC_POLICY **30min**, 复用刷新 | OpenAI 官方文档 (audit §1.3); custom provider 可能偏离 → reliability 0.85 + reason 注记 |
| pre-5.6 | EMPIRICAL 优先; 否则 **UNKNOWN** (placeholder 5m, reliability 0.2) | 5-10min in-memory 与最长 24h extended retention **本地不可区分** — 禁止假装知道 |
| 任何 | 本机历史证据 (相邻请求对) 可覆盖 | 与 Claude Code 共用的证据提取 (含 60s 下限/compaction 防护/haircut) |

实测回验: gpt-5.4 session (2026-03) 触发 EMPIRICAL (1169s, 来自自身历史); gpt-5.6-sol session 触发 STATIC 1800s。✓

## 6. 字段稳定性评级

| 字段 | 稳定性 | 说明 |
|---|---|---|
| `type`/`payload.type` | 稳定 | 未知 type 跳过+计数 |
| `payload.info.last_token_usage.*` | **高** (token_count 均有) | `info:null` 存在但罕见 |
| `input_tokens`/`cached_input_tokens` | **高** | cached ⊆ input 实测恒成立 |
| `cache_write_input_tokens` | 低 (语义) | §4.3 |
| `session_meta.id`/`cli_version`/`model_provider` | 高 | |
| `turn_context.payload.model` | 高 | 模型唯一来源 |
| `ordinal` | **无** (0.147) | 不可依赖 |
| `rate_limits` | 本机未见 | 未实现 |
| 目录布局 `YYYY/MM/DD` | 中 | 递归扫描兼容扁平/嵌套 |

## 7. Parser 强制要求 (与 Claude Code 同级)

未知 type 跳过; 半行/截断缓冲; zstd 检测跳过+计数; `info:null` 跳过; **不读取对话正文** (`response_item/message` 等内容行在 parser 层面只看 type 即弃); 垃圾行/空文件不崩溃; ambient (meta/turn_context) 头部提取 + 尾部 parse 组合 (大文件 tail-only 不丢模型信息)。

## 8. 已知局限 / 未解

1. custom provider 下 GPT-5.6 的 cache_write=0 不可信 (缓存实际在增长) — 写入侧成本核算 (Phase 2) 对 Codex custom provider 只能用"前后 cached 差"近似;
2. 同文件内 timestamp 可能非严格单调 (未观测到, 防御性排序保留);
3. zstd 压缩 rollout 本机无样本 — 检测逻辑只有合成测试覆盖;
4. `session_index.jsonl` 格式未审计, 未用作发现加速。

---
*Audit date: 2026-08-20 · codex-cli 0.147.0 · win32 · 真实数据: 2026-03~08 rollouts (gpt-5.4, gpt-5.6-sol, gpt-5.6-luna)*
