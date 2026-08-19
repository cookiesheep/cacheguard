# Cache-TTL Validation Experiment (Phase 1.5)

> 2026-08-19 · session `eff2fc29-23ef-4567-8d47-17e0887c51c1` · GLM 网关 (BigModel, Anthropic 兼容端点)
> 执行方式: `experiments/run-idle-experiment.mjs` (headless `claude -p --resume`, 独立 CLAUDE_CONFIG_DIR)
> 取数: 全部经产品管线 (`cacheguard status/backfill` → SQLite), 无独立解析器
> 预算: 1,357,559 input-equivalent tokens (硬上限 1.5M, 目标 1M — 超目标原因见 §7)

---

## 0. 结论 (一页版)

| 问题 | 结论 | 置信 |
|---|---|---|
| cache telemetry 是否稳定出现 | **是** — 23/23 个 API 响应均产出可解析 usage, 零解析失败 | VERIFIED |
| GLM 网关 TTL 窗口 | **存活 >20m07s, 40m09s 时全量 MISS** → TTL ∈ (20.1, 40.2] min | VERIFIED (n=1 miss, 单点) |
| **read 是否刷新 TTL (核心问题)** | **是** — 40min 空闲 + 中点(20min)整读 → 40m16s 时 100% 命中; 对照组 (40min 无中点) MISS。**2/2 周期** (周期2的中点读本身只 25%, 其请求触发的重写同样延续了存活) | VERIFIED (周期1为干净证据; 存在负载逐出噪声, 见 §5) |
| EMPIRICAL_ESTIMATE 偏差 | 跨 session 预测 32.4min ∈ 实测窗口 (20.1, 40.2] ✓; session 内保守估计 16.1min 为下界口径 | VERIFIED |
| 无法解释的观测 | 4 项 (§6) — 最重要: **~21.4k token 的部分命中层** 在 3/12 个空闲探测中复现 | 事实, 待解释 |

**对 Phase 3 的含义**: GLM 网关上 "读刷新 TTL" 成立 → 定时 touch (读或重写) 可将缓存存活无限延续; 但 20min 内 2 次部分逐出说明延续是概率性的, keepalive 决策引擎必须把逐出风险建模为非常数。

---

## 1. 实验设置

- **通道**: `claude -p --resume <id> --max-turns 1 --settings '{"alwaysThinkingEnabled":false}'`, cwd=`experiments/lab`, 独立 `CLAUDE_CONFIG_DIR` (无插件/无用户 memory, 前缀最小且稳定)。网关 env (ANTHROPIC_BASE_URL/token) 显式继承自用户真实 settings.json — 与日常同一 GLM 网关。
- **通道演进**: attempt-1 (继承用户完整配置) 因两个混淆源废弃 — claude-mem 插件在轮间更新注入 memory 导致前缀漂移 (r2 命中仅 31.5% 且 ctx 缩水), 以及 alwaysThinking+xhigh 使单个 "ok" 产生 4 个内部轮次 (~135k tokens)。详见附录 B。
- **上下文**: 读取 bigfile1 (~62k tokens, 3 个 Read 分块) 至 ctx≈85.5k。
- **探测**: 每次一条 "ok" (恰好 1 个 API 调用), `--max-turns 1`。
- **阶梯**: 名义 [3,6,10,20,40] min; **真实间隔按遥测时间戳计** (表中列)。
- **Refresh 臂**: G=40min (阶梯中最小 MISS 间隔)。每周期: 锚点请求 → 静置 G/2 → 探测 → 静置 G/2 → 探测。×2 周期。

## 2. 完整记录表 (verified 事实)

ctx = in+cr+cc (产品口径); ratio = cr / 前一观测 ctx。

### 2.1 Sanity + Build

| 时刻 (UTC) | 真实间隔 | ctx | cr | ratio | 判定 |
|---|---|---|---|---|---|
| 13:53:42 | 新建 | 22,949 | 768 | 3.3%* | (跨 session 仅 ~768 tok 共享, §6.2) |
| 13:54:05 | 23s | 23,027 | 21,376 | 93.1% | HIT |
| 13:54:29 | 24s | 23,065 | 22,976 | 99.8% | HIT |
| 13:54:51 | 22s | 23,090 | 23,040 | 99.9% | HIT |
| 13:54:58→13:55:54 | build 内部 4 轮 | 23,139→85,463 | — | 98.5-100% | 读取分块累积 |

*headless 通道判定: **USABLE** (ratios 3.3%→92.8%→99.6%→99.8%; 首轮为新建 session, 不适用)。

### 2.2 Ladder (无中点触碰)

| 探测 | 真实间隔 | ctx | cr | ratio | 判定 |
|---|---|---|---|---|---|
| ladder-3m | **4m50s** | 85,406 | 21,376 | 25.0% | **PARTIAL** |
| ladder-6m | 6m07s | 85,447 | 85,376 | 100.0% | HIT |
| ladder-10m | 10m07s | 85,469 | 85,440 | 100.0% | HIT |
| ladder-20m | **20m07s** | 85,496 | 85,440 | 100.0% | HIT |
| ladder-40m | **40m09s** | 85,518 | **64** | **0.1%** | **MISS** |

### 2.3 Refresh 臂 (核心实验)

| 探测 | 距上一请求 | 距锚点累计 | cr | ratio | 判定 |
|---|---|---|---|---|---|
| c1 锚点 | 7s (接 MISS) | 0 | 85,504 | 100% | HIT (MISS 请求自身重写了前缀†) |
| c1-p1 (+20min) | 20m08s | 20m08s | 85,504 | 100% | **HIT** |
| c1-p2 (+40min) | 20m08s | **40m16s** | 85,504 | **100%** | **HIT** ← 对照组同间隔 MISS |
| c2 锚点 | 7s | 0 | 85,632 | 100% | HIT |
| c2-p1 (+20min) | 20m07s | 20m07s | 21,504 | 25.1% | **PARTIAL** (§6.1) |
| c2-p2 (+40min) | 20m08s | **40m15s** | 85,696 | **100%** | **HIT** |

† GLM 网关 cc 恒报 0 (自动缓存不报写入, §6.4), 重写由下一请求的 cr 证实。

**读刷新判定逻辑**: 对照 = 40m09s 无中点 → cr=64。实验 = 40m16s 有中点整读 → cr=85,504 (100%)。若读不刷新 TTL, 中点读不应改变 40min 处的存活 (TTL ≤ 40m09s 已被对照证明)。周期 1 构成**干净的 read→refresh 证据** (中点为 100% 整读)。周期 2 的中点只读到 25%, 但其触发的重写同样延续了存活 — 对 keepalive 而言 "任何 touch 都延续" 是更强的实用结论, 但严格区分 "读刷新" 与 "重写重建" 需周期 1 的证据。

## 3. Q1: telemetry 稳定性

- 23/23 个 API 响应 (含 4 个 build 内部轮) 经产品管线全部解析成功;
- `cache_read_input_tokens` 100% 出现; `cache_creation_input_tokens` 100% 出现但**恒为 0** (GLM 行为, §6.4);
- 多记录去重 (message.id) 与内部轮次的逐 observation 记账均正确 (预算 = 23 个 observation 的 ctx+output 之和, 与 claude -p 的累计 usage 口径一致)。

## 4. Q2: MISS 是否落在 EMPIRICAL_ESTIMATE 预期窗口

| 估计 | 值 | 来源 | 与实测关系 |
|---|---|---|---|
| 跨 session (实验前) | 32.4min (2,429s 存活 ×0.8) | ae6bfb8b 历史 | ∈ (20.1, 40.2] ✓ |
| session 内 (实验后) | 16.1min (1,208s 存活 ×0.8) | 本 session 证据 | 保守下界口径 |

偏差陈述: 产品估计是有意设计的保守值 (survived×0.8); 实测真值在 (20.1, 40.2] 内, 两种口径均未越界。**但需注意 n=1 的 MISS 是单点证据, TTL 也可能是分布 (见 §5)。**

## 5. 混淆因素清单

| 因素 | 实测 | 影响 |
|---|---|---|
| 本机其他 session 网关流量 (实验窗口 13:53-16:38Z) | **无** (cacheguard DB 全 session 查询: 用户三个活跃 session 的最后 API 调用均在窗口前 — 12:47 / 06:48 / 09:58) | 无共享前缀刷新污染 |
| 实验 watcher (soak) | 本地进程, 零网络 | 无 |
| 用户并发 Claude Code | 窗口内无 API 调用 | 无 |
| 部分命中事件 (2/12 空闲探测) | ~21.4k 层在 4m50s 和 20m07s 处出现 | **非单调 TTL 的证据** — 网关存在负载相关逐出或分层保留; TTL 应视为分布而非常数 |
| cc=0 恒定 | 无法直接观测重写量 | MISS 后的 "重写" 由后续 cr 推断, 非直接遥测 |

## 6. 无法解释的观测 (如实列出, 不硬凑理论)

1. **~21.4k 部分命中层**: 21,376 / 21,504 两个值在 3 个不同探测中复现 (4m50s, 20m07s ×2), 恰为前缀的 system+tools 基座量级。假说 (未验证): 网关对基座与对话层分别建 checkpoint, 对话层在负载下可能早逐出。与单调 TTL 不一致 — 同样 20m07s 间隔, ladder-20m 100% 命中而 c2-p1 只 25%。
2. **跨 session 前缀分叉于 ~768 tokens**: 同一 config 下新建 session 首请求仅命中 768 (两次观测: sanity-1 与分叉验证探测)。相同 system+tools 的前缀应共享更多 — 暗示前缀早期含 per-session 内容。
3. **cr 多为 256 的倍数** (768, 21,376, 85,504…) 但非全部 (如 22,976 % 256 = 192) — 粒度现象存在但边界不严格。
4. **GLM 网关 cc 恒为 0**: 包括全量 MISS 后的重建轮。写入侧遥测缺失, VERIFIED_MISS 的重建量只能间接推断。
5. (attempt-1, 附录 B) 用户配置下 r2 的 31.5% 部分命中伴随 ctx 缩水 — 插件 memory 漂移假说, 未在干净配置中复现。

## 7. 消耗与统计

- **总消耗**: 1,357,559 input-equivalent tokens (ctx+output 逐 observation 求和, 含 sanity 92k / build ~324k / 阶梯+refresh 臂 ~941k)。
- **超 1M 目标的原因**: bigfile 实际 ~62k tokens (计划估 22k — 行宽估计错误), 抬高每探测 ctx 至 ~85k。仍低于 1.5M 硬上限; 脚本的逐探测预算守卫全程有效。
- **25 步** (4 sanity + 4 build 内部轮 + 5 阶梯 + 6 refresh + 6 wait/杂项), 墙钟 13:53:42 → 16:37:59 UTC (**2h44m**, 其中 137min 为协议内空闲)。
- 1 次瞬态网关 is_error (build-1, 重试成功; 该步手动补跑后经 resync 计入预算)。

## 8. 附录 A: watch soak 首份数据

- `cacheguard watch --interval 2s` 连续 **180min** 指向实验 session: **0 重启, 0 stderr 错误, 未漏观测** (实验全部 23 个 observation 均在 DB 中, 与 watch 并发运行期间无 SQLITE_BUSY 失败 — busy_timeout=5000 生效)。
- 进程资源: RSS ~68MB 稳定; CPU 累计 ~4.1s / 165min (平均 <0.05%) — "对 Claude Code 无可感知影响"的目标在空闲 session 上成立。
- 采样缺陷 (如实): soak 脚本的 tasklist RSS 解析 regex 不匹配 `"66,388 K"` 格式, CSV 内存列缺失; 内存数据来自手动 PowerShell 采样 (68MB @ 165min)。

## 9. 附录 B: attempt-1 发现 (用户完整配置通道)

- 新 session 首请求即命中 48,576/48,715 (99.7%) — **账号级前缀共享**: 用户并行 session 的相同 system+tools+memory 基座 (含 10 插件注入 ~35k) 在网关处保持热态。
- 第 2 轮 31.5% 部分命中且 ctx 由 48.7k 缩至 44.2k — 前缀组成变化 (claude-mem memory 注入更新的主假说); 第 3 轮恢复 98.8%。
- 含义: 在用户真实环境里, "共享基座由并行流量保温" 与 "会话尾部的独立存活" 是两个叠加现象 — 产品在归因 MISS 时需区分 (cr 跌至基座量级 ≈ 尾部丢失; cr 跌至 ~0 ≈ 全丢)。

## 10. 附录 C: 实验产出的产品修复

`--claude-dir` 覆盖目录无 settings.json 时, policy 曾把端点误判为 Anthropic 原生 (STATIC_POLICY 5m)。已修复: 端点不可知时显式降级 UNKNOWN/EMPIRICAL, 并加回归测试 (37 测试通过)。修复后本 session 判定: EMPIRICAL_ESTIMATE 16.1min, 依据 "survived 1208s / missed by 2408s"。

---
*原始数据: `experiments/results.json` · `experiments/checkpoint.json` · `experiments/logs/` (含 attempt-1 归档) · SQLite `~/.cacheguard/cacheguard.db` (session eff2fc29, 23 observations)*
