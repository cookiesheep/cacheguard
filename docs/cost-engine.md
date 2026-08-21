# Cost Engine v1 设计 (Phase 2, "算得清")

> 状态: implemented · 2026-08-20
> 原则继承: 事实优先。**双账本 (Verified / Estimated) 是产品灵魂, 永不合并**; inferred 数值永不混入 verified 汇总; 查不到价格 → 只出 token 账并标 `PRICING_UNKNOWN`, 绝不造美元数。

## 1. 费率快照 (vendored 数据文件, 零网络)

`src/cost/pricing-snapshot.json` — 手工内置, 顶层 `snapshotDate: 2026-08-20`, 每条目带 `sourceUrl`。数值全部来自 [research-audit-2026-08-19.md](research-audit-2026-08-19.md) §1.2/§1.3 已核验的官方表及其引用的官方页面 — **没有任何数值凭记忆填写**; 审计未给出绝对牌价的模型 (claude-sonnet-5 / fable-5 / mythos-5 / gpt-5.6 之外的 gpt 系 / 裸别名 sonnet/opus/haiku) 一律不进快照, 走 PRICING_UNKNOWN 兜底。

| 条目 | input $/MTok | cache read | cache write | 依据 |
|---|---|---|---|---|
| claude-opus-5 | 5.00 | 0.50 (0.1×) | 6.25 (1.25×, 5m) / 10.00 (2×, 1h) | 官方价格表 (audit §1.2 倍率 ✅; 绝对价 golden 例来自任务书核验) |
| claude-sonnet-4-5 | 3.00 | 0.30 | 3.75 / 6.00 | 同上 (audit 引用的官方示例: $3/$0.30; 1.25×/2×) |
| claude-haiku-4-5 | 1.00 | 0.10 | 1.25 / 2.00 | 同上 ($1→$0.10 示例) |
| gpt-5.6 (含 -sol/-luna 等变体) | 5.00 | 0.50 (0.1×) | 6.25 (1.25×, 30m) | OpenAI 官方 (audit §1.3: 90% off + GPT-5.6 写入加价) |
| gpt-5.3-codex (pre-5.6) | 1.75 | 0.175 (0.1×) | **无**写入加价 | audit §1.3 |
| glm-* (经网关的 claude-code) | — | — | — | **积分口径** (2026-07-31 起): cached ≈ 1/4 input 权重 (官方系数 GLM-5.3: 6.9/1.7/24, 非高峰 50%); 无美元费率 → 当前仍只出 token 账, 积分计算为 V1.1 候选 (experiments/glm-quota-accounting.md) |

- **模型归一化**: 精确/前缀匹配 (`claude-opus-5-20xx…` → opus-5; `gpt-5.6-sol` → gpt-5.6; `glm-5.2` → quota 模式)。裸别名 (`sonnet`/`opus`/`haiku`, 本机真实出现过) 无法确定代际 → PRICING_UNKNOWN (诚实优先于覆盖面)。
- **costUSD 优先**: claude-code 记录若带官方 `costUSD` 字段 → spend 采用之 (`source: official`); 否则快照重算 (`source: snapshot`)。bleed 是反事实差值, 始终用快照价格 (costUSD 无法分解)。
- schema 字段 (`perMTok`, `sourceUrl`, 可选 `writeTtl`) 为未来 LiteLLM 离线快照替换/合并预留; 本轮不做导入。

## 2. 口径感知的成本公式

### 2.1 Anthropic 口径 (context = input + read + write)

```
miss_excess(verified bleed) = uncached × (p_in − p_read) + cacheWrite × (p_write − p_read)
```

(output 项在差值中抵消; uncached = input_tokens。) 对照反事实 = "整个 context 都按 read 价命中"。

**Golden 数字**: Opus 5, 100k 全量 miss, cc=0 → 100000×(5−0.5)/1e6 = **$0.45**; 5m 全重写 (cc=100k) 再加 100000×(6.25−0.5)/1e6 = **$0.575**, 合计 $1.025。pre-5.6 gpt 无写入加价 → 无第二项。

### 2.2 Codex 口径 (context = input 已含 cached; write 遥测不可靠)

```
miss_excess = uncached × (p_in − p_read)      // uncached = input − cached
                                             // 标注: 不含不可观测的写入加价 → 下界 (LOWER BOUND)
```

- 写入不可信时 (`cacheWriteUnknown` 或 claude-code 侧 GLM cc=0): 可用相邻请求 cached 增量推断写入, 产生 **inferred write surcharge** 行 — 展示但**永不计入 verified 汇总**。

### 2.3 双账本

| | Verified 账 | Estimated 账 |
|---|---|---|
| 来源 | 只有 classifyFact 判定的 MISS / PARTIAL_MISS 事实 | 纯前瞻推断 |
| 含义 | "这次 miss 比 full-hit 多花了多少" (cache bleed) | "若缓存此刻失效, 下次请求冷重建暴露是多少" = 当前 context × (p_in − p_read) (+已知写入项) |
| 标签 | verified (逐条带时间/金额/疑似原因) | estimated (永远带假设说明) |

### 2.4 Miss 归因粗分桶 (展示用, suspected/inferred 标签)

复用 P4 阈值: gap≥60s 且 context 稳定 (≥prev×0.6) → `suspected-ttl`; context 骤降 (<prev×0.6) → `compaction`; gap<60s → `suspected-prefix-break`; 无前观测 → `unknown`。深度归因是 Round 5。

## 3. CLI

- `cacheguard cost [sessionId]` — 总消耗 (token + 可定价时的 USD) / cache 节省 / **verified bleed 逐条明细** (时间+金额+疑似原因) / 当前 cold exposure (estimated);
- `cacheguard cost --all` — 跨 session 汇总 (按 agent 分组);
- `status` 增加一行 `Cache bleed (verified): $X.XX` (仅定价可用时);
- `--json` 与 status 同构, 每个金额带 `source: official|snapshot|reference` 与 `kind: verified|inferred|estimated`。

## 4. 已知局限 (v1 如实声明)

1. 输出 (output) 侧价格仅部分条目有官方核验值 → spend 拆分 prefill/output, output 无价时只显 token;
2. Codex custom provider 的 cache_write 恒 0 → bleed 恒为下界, inferred 写入项需要相邻请求;
3. GLM 网关无美元费率 → token 账 + (可选) 明确标注的"按 Anthropic 牌价折算参考", 默认不显示美元;
4. 裸模型别名与未收录模型 → PRICING_UNKNOWN (宁缺毋假);
5. 快照会过期 — 展示层带 snapshotDate。
