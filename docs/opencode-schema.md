# OpenCode 本地数据 Schema 审计

> **验证状态: 本机真实数据已验证** (opencode 1.3.17, Windows, `~/.local/share/opencode/`, 2026-08-20 审计; 5 sessions / 34 messages, 模型 gpt-5.4 与 gpt-5.4-mini, provider=openai)。
> OpenCode 无官方存储格式文档; 布局为实测 + sst/opencode 源码 (drizzle 迁移) 推导。

---

## 1. 数据在哪里

| 路径 | 说明 |
|---|---|
| `~/.local/share/opencode/opencode.db` | ⭐ **会话历史 (SQLite, drizzle)**: `session` / `message` / `part` 等表; WAL 模式 |
| `~/.local/share/opencode/storage/` | 1.3.x 仅存插件状态 (agent-usage-reminder / session_diff), **不含历史** |
| `~/.config/opencode/` | 配置 — CacheGuard 不读取 |
| XDG | 遵循 `XDG_DATA_HOME`; 本机 Windows 下仍为 `~/.local/share/opencode` [实测]; CacheGuard 另支持 `CACHEGUARD_OPENCODE_DIR` 覆盖 |

`part` 表含对话正文 — **从不查询** (privacy 红线); 我们只 SELECT `message` 的 id/time_created/data 与 `session` 元数据。

## 2. 关键表结构 (实测)

```
session: id (ses_*), directory (工作目录), title, time_created/updated (epoch ms), parent_id, version…
message: id (msg_*), session_id, time_created (epoch ms), data (JSON)
part:    对话正文与工具内容 — 不读取
```

`message.data` (assistant 行) 关键字段:

```json
{ "role": "assistant", "modelID": "gpt-5.4", "providerID": "openai",
  "cost": 0,
  "tokens": { "total": 39580, "input": 37916, "output": 27,
               "reasoning": 101, "cache": { "write": 0, "read": 1536 } },
  "time": { "created": 1775490286148, "completed": 1775490297550 } }
```

## 3. ⭐ 口径结论 (实证, 非类比)

**加法口径 (Anthropic 型)**: 本机全部 23 条非退化 assistant 消息精确满足

```
tokens.total = input + output + reasoning + cache.read     (23/23, 0 例外)
```

→ **`input` 不含 cached 部分** — 即使 provider=openai (OpenAI 原生 API 的 input_tokens 本包含 cached, OpenCode 在 usage 归一化时做了减法, 源码确认见 §6)。因此:

```
contextTokens = input + cache.read + cache.write           (与 Claude Code 同公式)
cacheRatio    = cache.read / contextTokens
```

3 条不匹配样本均为全零退化行 (input/output/cache 全 0) — parser 按 F2 规则跳过。本机无 cache.write>0 样本 (write 恒 0); write 语义按字段形状纳入加法 (源码形状确认)。

## 4. 去重与观测

- requestId = `message.id` (msg_*, 天然唯一) — 无 Claude Code 的多记录放大问题;
- 一条 assistant message = 一个观测 (tokens 为该消息最终累计; part 层的 step-finish tokens 不单独取);
- `cost` > 0 时作为 officialCostUsd (本机样本恒 0 — OpenCode 未配置计价时的表现);
- 模型: `modelID`; provider: `providerID` (供 policy 参考语境, 不用于猜费率)。

## 5. TTL Policy / 费率 (按既有规则)

- **模型家族驱动** (与 Codex 分支共用): `claude-*` → Anthropic 5m 静态 (reliability 0.8, provider 路由可能偏离); GPT-5.6+ → 30m 静态; 其余 (含本机 gpt-5.4) → EMPIRICAL 优先, 否则 UNKNOWN (pre-5.6 的 5-10min vs 24h 不可区分);
- 费率: `gpt-5.4` / `gpt-5.4-mini` 不在快照 (审计未核验其牌价) → **PRICING_UNKNOWN, 只出 token 账** — 本机实测正是如此 (cost 命令输出 token ledger)。

## 6. 字段稳定性评级

| 字段 | 稳定性 | 说明 |
|---|---|---|
| `message.data.tokens.{input,cache.read/write,output}` | 高 (26/26 有 tokens) | 形状来自 OpenCode 归一化层, 跨 provider 一致 |
| `tokens.total` 不变量 | **高 (23/23 非退化)** | §3 口径依据 (主证据为真实数据不变量; 源码形状见 message.ts schema) |
| `modelID` / `providerID` | 高 | |
| `time.created` | 高 | epoch ms; 缺失时回退行级 time_created |
| 全零退化行 | 存在 (3/26) | 跳过 (F2 规则) |
| `cost` | 中 (本机恒 0) | >0 才作 official |
| DB 布局本身 | 中 | drizzle 迁移会演进; 查询仅依赖 session/message 两表最小列集 |
| 旧版文件式 storage (storage/message/*.json) | 未观测 | 1.3.x 已入 DB; 旧布局未实现, 遇到时如实报 "no sessions" |

## 7. 已知局限

1. 本机无 cache.write>0 与 anthropic-provider 样本 — write 加法项与 claude 静态分支由形状/文档支撑, 未被本机数据直接验证;
2. watch 模式为 2s DB 轮询重快照 (非增量 tail) — 会话很大时每次轮询有查询成本 (当前按行限读);
3. 多 provider 路由 (自定义 baseURL) 下静态 TTL 可能偏离 — 已在 reason 中标注。

---
*Audit date: 2026-08-20 · opencode 1.3.17 · win32 · 真实数据: 本机 opencode.db (5 sessions / 34 messages, gpt-5.4 系)*
