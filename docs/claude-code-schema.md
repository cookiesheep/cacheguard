# Claude Code 本地数据 Schema 审计

> 本文基于对**当前机器真实数据**的审计, 不是对文档的记忆或猜测。
>
> - Claude Code version: **2.1.235**
> - OS: Windows 10 (10.0.26200), 用户目录 `C:\Users\<user>\`
> - 审计日期: **2026-08-19**
> - 审计方式: 直接解析 `~/.claude/` 下真实 session JSONL (抽样 2 个项目目录、约 20 个 session 文件, 最大单文件 101 MB)
>
> **警告**: 该 schema 不是永久 API。Claude Code 迭代很快 (本次审计已发现多个旧版文档未记载的 record type)。Parser 必须按"未知字段/未知 record type 一律容忍并跳过"设计。

---

## 1. 数据在哪里

| 路径 (相对 `~/.claude/`) | 内容 | 对 CacheGuard 的价值 |
|---|---|---|
| `projects/<munged-cwd>/<sessionId>.jsonl` | **session 主文件**, 逐 API 事件 append | ⭐ 核心: cache telemetry 唯一可靠来源 |
| `projects/<munged-cwd>/<sessionId>/subagents/agent-*.jsonl` | subagent (Task tool) 的 sidechain 记录 | 有 usage, 但 `isSidechain=true`, 统计主 session 时须排除 |
| `sessions/<pid>.json` | **运行中 session 注册表** (见 §3) | ⭐ 识别"当前活跃 session"的第一信号 |
| `history.jsonl` | 用户输入历史的 display 文本 (含 prompt 内容) | ⚠️ 含敏感内容, CacheGuard **不读取** |
| `settings.json` | 配置, `env` 里可能有 `ANTHROPIC_BASE_URL` 等 | 可用于识别 provider (注意含 token, 不可入库) |
| `telemetry/` | 1p failed events 等 | 与本工具无关 |
| `statsig/`, `shell-snapshots/`, `file-history/` 等 | 其他运行时数据 | 无关 |

`<munged-cwd>` 是把工作目录路径中的非字母数字字符替换成 `-` 得到的 (如 `D:\code\foo` → `D--code-foo`)。该映射**有损**, 不应反向推算路径; 应遍历目录而不是计算 munged 名。

## 2. Session 主文件: 每行一个 JSON record

顶层公共字段 (几乎所有 record 都有):

```
type, uuid, parentUuid, timestamp, sessionId, cwd, version, gitBranch,
userType, entrypoint, isSidechain
```

`timestamp` 为 ISO-8601 UTC (如 `2026-08-19T09:51:58.046Z`)。

### 2.1 实测 record type 分布 (v2.1.235)

| type | 出现频率 | 说明 |
|---|---|---|
| `user` | 高 | 用户输入; `isMeta=true` 为系统注入的 meta (如 cue), 非真人输入 |
| `assistant` | 高 | **API 响应, `message.usage` 是 cache telemetry 所在** (§4) |
| `attachment` | 高 | 附件类结构化数据 |
| `system` | 中 | API 错误、compaction 等系统信息 |
| `queue-operation` | 中 | 输入队列操作 |
| `last-prompt` / `atis-latch` / `permission-mode` / `file-history-snapshot` / `custom-title` / `agent-name` | 低~中 | UI/内部状态记录, 无 usage; **`last-prompt` 无 timestamp 字段** |
| `summary` | 本次未观测到 (旧版/社区资料: resume 时出现在文件头, 含 `leafUuid` 指向其他文件) | 兼容保留 |
| `compact_boundary` | 本次未观测到 (社区资料: `/compact` 时写入, 含 `compactMetadata{trigger, preTokens}`) | compaction 检测用 (见 §7 防护) |

**未知 record type 必须跳过而不是报错** — 这是 v2.1 相比公开资料新增了大量 type 的直接教训。

### 2.2 assistant record 的关键字段

```
{
  "type": "assistant",
  "uuid": "...", "parentUuid": "...",        // 记录链, 用于重建对话树
  "timestamp": "2026-08-19T09:51:58.046Z",
  "sessionId": "...", "cwd": "...", "version": "2.1.235",
  "isSidechain": false,
  "message": {
    "id": "msg_...",                          // ⭐ API 响应 ID, 去重键 (§5)
    "model": "glm-5.2",                       // 模型名; "<synthetic>" 见 §6
    "content": [...],                         // 内容块 — CacheGuard 不读取
    "usage": { ... }                          // ⭐ 见 §4
  }
}
```

注意: `message.usage` **不在每条 assistant record 上都保证完整** — 实测一个 2548 条 assistant 记录的文件中有 29 条 `usage` 缺少 `cache_read_input_tokens` 字段。

## 3. 活跃 session 识别: `sessions/<pid>.json`

以 PID 为文件名的注册表, 每个**正在运行的** Claude Code 进程一个文件。实测样例:

```json
{
  "pid": 25748,
  "sessionId": "ae6bfb8b-...",
  "cwd": "D:\\code\\build-your-own-claude-code",
  "startedAt": 1787132937003,
  "version": "2.1.235",
  "kind": "interactive",
  "entrypoint": "cli",
  "name": "第二大炮",
  "status": "idle",                  // 观测到 "idle"; 推测还有 "running" 等, 未穷举
  "updatedAt": 1787133569709,
  "statusUpdatedAt": 1787133569709
}
```

要点:
- 这是发现活跃 session 的**首选信号** (比 JSONL mtime 更可靠);
- `updatedAt` 只在事件发生时更新, 空闲 session 可能数小时不更新 — **不能仅凭 updatedAt 判死活**; 退出进程的文件可能残留;
- 兜底策略: registry + JSONL mtime 双信号, registry 缺失 (旧版本 Claude Code) 时退化为纯 mtime 扫描。

## 4. Cache telemetry: `message.usage` 结构

实测 (逐字段频率统计, 52/52 条全有的字段):

```json
{
  "input_tokens": 1536,
  "cache_creation_input_tokens": 0,          // 本次请求新写入 cache 的 token
  "cache_read_input_tokens": 39488,          // 本次请求命中 cache 的 token ⭐
  "output_tokens": 508,
  "output_tokens_details": { "thinking_tokens": 0 },
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "cache_creation": {
    "ephemeral_1h_input_tokens": 0,          // 1h TTL cache 写入 (Anthropic 语义)
    "ephemeral_5m_input_tokens": 0           // 5m TTL cache 写入 (Anthropic 语义)
  },
  "inference_geo": "", "iterations": [], "speed": "standard"
}
```

派生量 (与 Anthropic usage 语义一致):

```
contextTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
cacheRatio    = cache_read_input_tokens / contextTokens
```

新版本部分记录还带顶层 `costUSD` (Claude Code 预计算的每消息成本) 与 `requestId` — 本机 2.1.235 未观测到 (可能为 API-key 计费环境特有); Phase 2 Cost Engine 再决定是否采用。

**重要环境事实**: 本机 Claude Code 通过 `ANTHROPIC_BASE_URL` 指向 BigModel GLM 兼容网关 (`open.bigmodel.cn/api/anthropic`), 模型为 `glm-4.7/5.1/5.2/5.3` 等。usage 结构遵循 Anthropic wire format, 但 **TTL 行为由网关决定, 不能套用 Anthropic 官方 5m TTL** (§7 的实测证据支持这一点)。这直接论证了 ProviderPolicy 必须可插拔、且允许运行时观测覆盖静态策略。

## 5. ⚠️ 去重: 一个 API 响应会产生多条记录

实测一个 session: **2548 条带 usage 的 assistant 记录, 实际只有 885 个唯一 `message.id`**。同一响应 (同一 `message.id`, 同一 usage 数字) 会被写成 1~17 条记录 (每个 content block / tool_use 一条, 流式分块落盘)。

**Parser 必须按 `message.id` 去重, 否则 token 统计会放大 2~3 倍。** 去重时以首次出现的记录为准 (其 usage 与后续重复记录一致)。

`message.id` 在实测中 100% 存在, 但仍需容忍缺失 (缺失时退化为按 `uuid` 不去重, 标记低置信)。

## 6. ⚠️ `<synthetic>` 记录与其他异常

- `message.model == "<synthetic>"` 的记录: `isApiErrorMessage: true`, usage 全为 0 (如 "No response requested.")。**必须跳过, 不产生 observation**。
- 时间戳**非单调**: 长寿 session 跨天 resume 时, 文件内时间戳会前后跳跃 (实测同一文件内有跨 ~8 天的交错记录)。`--resume` 会**追加到旧 session 文件** (session id 复位为旧 id), 文件边界 ≠ 会话边界, 会话是跨文件的 DAG (`parentUuid` 重建)。**按文件偏移顺序处理, 按时间戳排序后再分析**; 不要假设 append 顺序 == 时间顺序。
- JSONL 尾部可能有**半行** (正在写入) — tailer 必须缓冲不完整行, 等待后续数据补齐。
- 社区报告 (ccusage #888 / gille.ai): 同一 `message.id` 的重复记录中 `output_tokens` 可能是流式中间快照 (keep-first 会低估 output); `input_tokens` 可能是 0/1 占位符。**`cache_read_input_tokens` / `cache_creation_input_tokens` 在流式开始前即确定, 是 JSONL 中最可靠的字段子集** — 本机数据验证重复记录的 cache 字段完全一致。
- transcripts 按 `cleanupPeriodDays` (默认 30 天) 清理 — 长期监控必须自带存储 (CacheGuard 的 SQLite 即为此设计)。

## 7. 实测 cache 生命周期证据 (本机, GLM 网关)

对活跃 session 的时间序列分析 (相邻去重后观测之间的 idle gap → 下一次请求的 cache_read):

| Idle gap | 下一次 cache_read | 解读 |
|---|---|---|
| 64~500s | 保持高位 (如 gap=497s → cr=138,688) | cache 存活 |
| ~550s | cr=384 (残量) | 近全 miss |
| 306~535s 多次 | 高位命中 | TTL 明显 > Anthropic 默认 5m |
| 4.5min+ | 部分保留 | 分层 cache (小 prefix 残留: 256/384/1152) |
| 冷启动 | cr=0, cc=90,767 | 全量重建的典型签名 |

结论: **idle gap 与 cache miss 的因果关系在本机数据中清晰可见**, Phase 1 的核心假设成立。同时本机网关的 TTL 行为与 Anthropic 官方文档不同 → TTL 必须来自 ProviderPolicy 且支持 EMPIRICAL_ESTIMATE。

## 8. 字段稳定性评级

| 字段 | 稳定性 | 说明 |
|---|---|---|
| `type` | 稳定 | 但新 type 会持续出现, 须容忍 |
| `message.usage.cache_read_input_tokens` | **高** (52/52; 另一文件 2519/2548) | 偶有缺失, default 0 并标记 |
| `message.usage.cache_creation_input_tokens` | 高 | 同上 |
| `message.usage.cache_creation.ephemeral_*` | 中 | Anthropic 原生才有意义; 网关下恒 0 |
| `message.id` | 高 | 去重键 |
| `message.model` | 高 | 含 `<synthetic>` 哨兵值 |
| `timestamp` | 稳定 | UTC ISO, 非单调 |
| `sessions/<pid>.json` | 中 | 新机制, 旧版本无; 字段可能变化 |
| `isSidechain` / subagent 目录布局 | 中 | 统计主 session 时排除 |

## 9. 对 Parser 的强制要求 (汇总)

1. 未知 record type / 未知字段: 跳过, 不报错, 记入 debug 计数;
2. `message.id` 去重;
3. 跳过 `<synthetic>` 与 `isApiErrorMessage` 记录;
4. usage 字段缺失: 该 observation 标记 `partial`, 不丢弃整个记录 (input/output 可能仍在);
5. 半行 JSON / 截断: 缓冲等待, 单行解析失败跳过并计数, **绝不让整个 monitor 崩溃**;
6. 记录 `version` 字段 (每条 record 自带) 入库, 供 schema 漂移分析;
7. 默认排除 `isSidechain=true` (后续可加 `--include-sidechain`);
8. 不读取 `message.content`、`history.jsonl` 等含正文的数据 (privacy)。

---
*Investigation date: 2026-08-19 · claude-code 2.1.235 · win32* \
*本文件应随 schema 变化与新版本审计更新。*
