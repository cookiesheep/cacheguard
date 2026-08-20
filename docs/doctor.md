# Cache Doctor — 归因诊断与隐私红线

> `cacheguard doctor [sessionId]` · implemented 2026-08-20 · 代码: `src/doctor/analyze.ts`

## 信号与优先级

具体信号优先于泛化猜测 (全部 metadata-only):

| 优先级 | 信号 | 判定 | 级别 |
|---|---|---|---|
| 1 | **model switch** | miss 边界前后 observation 的 model 不同 | suspected (行为本身官方确认, 对具体 miss 是归因推断) |
| 2 | **compaction** | context 骤降至前一观测的 <60% | suspected |
| 3 | **suspected TTL** | gap ≥60s 且 context 稳定 | suspected |
| 4 | **suspected prefix break** | gap <60s 且 context 稳定 | suspected |
| + | **recurring residual layer** | 多次 PARTIAL miss 留下相近残量 (±15% 聚类, ≥2 次) | inferred (分层缓存假说) |
| + | **hour clustering** | bleed 事件按本地小时聚合 | 事实 (聚合本身), 解读是推断 |

每条建议 (advice) 必须携带 `evidence` 字段点名证据; 文案禁止确定性断言 ("provably/will" 等词在测试中被断言不存在)。

## 隐私红线 (不可妥协)

1. **不解析、不存储、不指纹化任何对话内容** (message content / tool result / prompt 正文)。分析输入仅限: token 计数、时间戳、模型名、session 元数据。
2. Token 级 prefix diff 归因需要内容指纹 → **未来 opt-in 功能, 当前明确不做**。本轮所有归因只依赖 timing/数量/模型名三类 metadata。
3. 该红线与产品级隐私承诺一致 (零网络、不写 agent 数据目录), 见 README Privacy 节。

## 已知局限

- 归因是启发式分桶, 不是因果证明 — 所有输出带 suspected/inferred 标签;
- residual layer 聚类 (±15%) 可能把巧合的相近残量归为一层;
- 深度读取 (doctor 默认 32MB tail) 会比 status (4MB tail) 发现更多历史事件 — 两者数字可能不同, 这是读取深度差异, 不是数据矛盾。
