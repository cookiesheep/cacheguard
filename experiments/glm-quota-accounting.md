# V1 实验:GLM Coding Plan 配额核算 — 结论报告

> 2026-08-21 · 纯实验轮 (无产品代码改动) · 取证按成本递进,任一级定论即停
> **结论级别: 官方文档 [A] 定论** — 无需实验级对照 (规则明示停止于①)

---

## 0. 一页结论

| 问题 | 答案 | 证据 |
|---|---|---|
| **cached token 配额权重** | **折扣 ≈ 1/4**(GLM-5.3: Cached 系数 1.7 vs Input 6.9 = **24.6%**;GLM-4.7 26.1%;5-Turbo 26.3%) | **[A] 官方公式原文** (docs.bigmodel.cn 与 docs.z.ai 双站一致) |
| uncached input 权重 | 1×(基准系数,如 GLM-5.3 = 6.9) | [A] |
| **cache write 权重** | **0(公式中无 write 项;按量计费侧"缓存存储限时免费")** | [A] + 明示缺失 |
| 配额单位 | **积分(非 token)**: `积分数 = (in×Input系数 + cached×Cached系数 + out×Output系数) / 10000` | [A] |
| 附加规则 | 非高峰(工作日 14-18 点以外)**全部 50% 抵扣**;MCP 调用按 Output 系数×次数 | [A] |
| 官方 TTL | **未公布**("缓存有合理时限,过期后重新计算") | [A] 缺失 |

**→ 落入分支一 (cached 有折扣),但非"miss 烧配额"的简单版**: miss 的真实代价是 input 侧 **~4×**(6.9/1.7) 于 hit,且 write 免费。keepalive **有条件回归** 路线图 (见 §4,含对调研初稿一处算术的纠正)。

## 1. 三路取证过程

### ① 文档级 — 定论 ✅ (停止点)

**官方积分公式原文** (docs.bigmodel.cn/cn/coding-plan/overview,2026-08-21 抓取;z.ai devpack/overview 同文):

> "模型消耗积分数=(输入 Token × Input 抵扣系数 + 缓存命中 Token × Cached Input 抵扣系数 + 输出 Token × Output 抵扣系数) / 10000"

系数表 (双站一致):

| 产品 | Input | **Cached Input** | Output | cached/input |
|---|---|---|---|---|
| GLM-5.3 | 6.9 | **1.7** | 24 | **24.6%** |
| GLM-5-Turbo | 5.7 | 1.5 | 21 | 26.3% |
| GLM-4.7 | 4.6 | 1.2 | 16 | 26.1% |
| GLM-4.6V | 1.2 | 0.3 | 2.7 | 25% |

套餐额度 [A]: Lite 2,000 积分/5h + 10,000/周; Pro 12,000/60,000; Max 28,000/140,000。官方用量估算表本身按 90.9%/95%/98% 三档命中率给出不同 token 额度 — **官方自己承认命中率直接决定有效配额**。

**关键时间线澄清**: R1 审计记录的社区证据"cached 全额计配额"(r/ZaiGLM 多帖)全部来自 **2026-04~06**,即 **2026-07-31 积分制切换之前**的旧限额制 (V2 token bank,cache read ~1:1 计)。审计时未察觉该体系已切换 — 本轮已核实并修正所有相关文档表述 (§5)。测量时间线独立来源: jia.je/kb/software/coding_plan.html ("2026/07/31 GLM Coding Plan 从限额改为积分制";"2026/08/14 GLM-5.2→5.3 系数不变 6.9/1.7/24")。

**按量计费交叉证据** [A]: z.ai 价格表 GLM-5.3 $1.40 in / **$0.26 cached** / $4.40 out (≈18.6%);国内 8元/2元/28元 (≈25%,[D] 媒体)。注意 bigmodel 缓存页 prose 写"通常为标准价格的 50%" — 与价目表矛盾,以价目表/系数表为准。缓存页明示"仅适用于标准 API 计费,不包括…GLM Coding Plan 套餐"(即套餐走积分系数,不按该页计)。

### ② 接口级 — 穷尽,无配额端点 (记录)

- Anthropic 兼容端点响应头: 仅 trace/process-time,**无配额/ratelimit 字段** (最小请求实测,`experiments/logs/quota-probe-headers.json`);
- 兼容层盲探: `/v1/me` `/v1/usage` `/v1/organizations` 404,仅 `/v1/models` 200 (`quota-probe-anthropic-compat.json`);
- 开放平台候选端点 6 个: 全 404 或 HTML 登录页 (`quota-probe-endpoints.json`);
- ZCode 专用 `zcode.z.ai/api/v1/zcode-plan/*` 5 个子路径 404 (`quota-probe-zcode-plan.json`);
- **ZCode 命中率来源已定位** [D-本机检查]: ZCode 本地 sqlite (`~/.zcode/cli/db/db.sqlite` 的 model_usage/turn_usage 表) 自算 `cacheRead/inputTokens`,非官方统计端点;本机全程命中率 GLM-5.3 ≈95.5%,GLM-5.2 ≈98.4%。远端套餐额度走需登录态的 Web API (文档 zcode.z.ai/cn/docs/usage-stats "读取远端额度与消耗"),无公开 API 文档。
- 结论: **无编程可读的配额刻度** → 若未来需要实验级,只能走"用户两个时刻各读一个数"或 Web 会话 API (需用户授权)。

### ③ 实验级 — 未启动 (①已定论,按规则停止)

受控对照实验未消耗任何配额。全程实际消耗: 1 次最小 messages 请求 (14 input tokens) + 若干零成本 GET 探测。

## 2. 判别过程 (cached 权重)

1. 公式明示三类 token 分别乘不同系数 → 排除"统一 1×";
2. Cached 系数 1.7 ≠ 0 → 排除"cached 免费";
3. 1.7/6.9 = 24.6% → **折扣约 1/4**,非全额;
4. write 无项 → 权重 0;
5. 交叉验证: 按量计费侧 cached ≈ 18.6-25% — 与积分系数比例一致 (两套体系独立同向);
6. 时间线验证: 旧"全额计"证据均早于积分制切换日,与新公式无矛盾。

## 3. 对 keepalive (Phase 3) 的判定建议

**修正一个算术错误** (调研初稿 §8 称 keepalive "spends 6.9×N"): keepalive 请求的前缀是**从缓存读的** — 命中即付 Cached 系数 1.7×N,而非 Input 6.9×N (只有缓存已死才付 6.9×N,而那正是 keepalive 要防止的)。正确经济账:

```
touch 成本   = prefix×1.7 (+新增 token×6.9,可忽略) ;非高峰再×0.5 = 0.85×prefix/万
防止的损失   = 若缓存死亡,下次请求 prefix×6.9 (input 侧重付)
比值         = miss 代价 ≈ 4× touch 成本 (6.9/1.7)
keepalive 净收益 > 0 ⟺ P(用户在 touch 窗口内回归) × 6.9N > touch 次数 × 1.7N + output
```

**建议: keepalive 有条件回归路线图,但暂不启动**。理由:

1. ✅ 经济学为正的条件存在 (4× 比值,非高峰减半加成); 
2. ⚠️ **无官方 TTL** — 触发节奏只能靠我们的 EMPIRICAL 估计 (Phase 1.5 实测 (20,40]min + 负载逐出是分布);官方"缓存命中率优化使有效额度提升约 30%"的内部口径也佐证头部空间存在;
3. ⚠️ 高命中率 harness (ZCode 95-98%) 空间小;主战场是 **Claude Code/Codex 经 GLM 网关的用户** (无自动保温,长空闲后 miss);
4. 📋 回归门槛 (建议写入路线图): 用 CacheGuard 自身的 quota 账本积累真实用户 miss 成本分布 (V1.1 功能,见 §5),当"可归因 miss 消耗"达到可观比例且空闲-回归模式清晰时再动工;touch 间隔由 EMPIRICAL TTL 驱动。

## 4. 产品含义 (下轮 V1.1 候选,本轮不实现)

- **quota 模式可计算积分**: 系数全公开 → `cacheguard cost` 对 GLM 会话可输出官方积分账 (in×6.9 + cached×1.7 + out×24)/10000 + 非高峰判断 — 比"token 账"更贴近用户真实配额;需 vendored 系数表 (同 pricing-snapshot 模式,snapshotDate 2026-08-21);
- miss 归因的"代价"行可从 token 升级为积分 (4× 权重差);
- statusline 的 bleed 行在 quota 模式下可显示积分。

## 5. 本轮事实修正 (陈旧表述清理)

项目内三处"GLM cached 全额计配额、无折扣"表述源自 R1 审计的社区证据,已被积分制推翻,已更新: `src/cost/pricing-snapshot.json` quotaModes note (仅文案,无行为变化)、`docs/cost-engine.md` §1 表行、memory。R2 audit 文档本身为历史记录不改,dev plan 注记勘误。

## 6. 原始数据

- 探测记录: `experiments/logs/quota-probe-{headers,endpoints,anthropic-compat,zcode-plan}.json`
- 文档来源: docs.bigmodel.cn/cn/coding-plan/overview · docs.z.ai/devpack/overview · docs.bigmodel.cn/cn/guide/capabilities/cache · docs.z.ai/guides/overview/pricing · zcode.z.ai/cn/docs/usage-stats · jia.je/kb/software/coding_plan.html (时间线) · r/ZaiGLM 历史帖 (旧制证据)
- ZCode 本机 DB: `~/.zcode/cli/db/db.sqlite` (model_usage;命中率 95.5%/98.4%)

---
*实验消耗总计: 14 input tokens + 零成本 GET。全程未触碰用户 Web 会话/浏览器凭据。*
