# CacheGuard Development Plan

> 工程日志 · 按阶段更新 · 原则: **事实优先于项目设想**
>
> **工程门禁 (2026-08-20 起, 强制)**: 每次 commit 前必须 `npm run build && npm test` 双绿。测试绿 ≠ 构建绿 — Round 3 曾出现 build 失败但测试通过被提交的情况 (CLI 描述笔误), 此规则即其教训。
> Last updated: 2026-08-19 (Phase 1.5 进行中)
> 独立事实复核与竞争审计: [research-audit-2026-08-19.md](research-audit-2026-08-19.md) — 战略校准结论 (§2.2): "看得见"为主产品、主战场是非官方端点+多 agent+长期账本; "自动做"收窄为 economics-aware (值得时才保护)。

---

## 0. 当前状态总览

| Phase | 状态 | 说明 |
|---|---|---|
| Phase 0 — Investigation & Architecture | ✅ 完成 | 本机 schema 审计 + 官方机制调研 + 同类项目调研 + 技术栈决策 |
| Phase 1 — Read-only Cache Monitor (MVP) | ✅ 实现并通过真实数据验证 | 见 §2 验收清单 |
| Phase 1.5 — Controlled idle-time experiment | ✅ **完成 (2026-08-19)** | 核心结论: GLM 网关 TTL ∈ (20.1, 40.2]min; **read 刷新 TTL 成立** (2/2); 详见 [experiments/cache-ttl-validation.md](../experiments/cache-ttl-validation.md) 与 §5.5 |
| Round 3 — CodexAdapter (跨 Agent 第一步) | ✅ 完成 (2026-08-20) | 真实数据验证 (本机 codex-cli 0.147, gpt-5.4/5.6); 见 §5.6 |
| Phase 2 — Cost Engine | ⬜ 未开始 (gate 已通过) | 费率已调研 (§4); GLM cached token 全额计配额 → 省配额模型核心 |
| Phase 3 — Auto Protect | ⬜ 未开始 | 明确不提前实现; refresh 语义已 verified, 决策引擎需建模逐出概率 |

代码结构:

```
src/
├── adapters/claude-code/   # adapter.ts(发现) paths.ts(定位) parser.ts(JSONL→观测)
├── adapters/codex/         # CodexAdapter: 递归发现(zstd 跳过) + rollout parser(ambient 头提取)
├── cache/estimator.ts      # 事实/推断状态机 (agent 感知)
├── collector/tailer.ts     # 增量 tail + 半行缓冲 + 截断检测
├── policy/provider-policy.ts  # TTL 来源解析 (Anthropic/OpenAI 双分支 + EMPIRICAL/UNKNOWN)
├── sessions/engine.ts      # 多 agent 管线编排 + 事件记录
├── storage/db.ts           # SQLite (sessions/observations/cache_events)
├── cli/                    # status / watch / sessions / events / backfill (--claude-dir/--codex-dir)
└── types/                  # 统一数据模型 (AgentKind: claude-code | codex)
tests/  58 个用例 (双 parser 健壮性 / estimator / policy 双分支 / tailer / storage / codex 发现)
docs/   claude-code-schema.md · codex-schema.md · architecture.md · development-plan.md · research-audit-2026-08-19.md
experiments/  run-idle-experiment.mjs · soak-watch.mjs · cache-ttl-validation.md · results/logs
scripts/schema-audit.mjs    # 重新审计本机 Claude Code JSONL schema
```

## 0.5 方向定型 (用户拍板, 2026-08-20, 不再讨论)

**项目定位: 面向全球 Claude Code + Codex 用户的开源跨 Agent 缓存可观测工具 (ccusage 路线)。**

- 目标: 用户量与社区; 经济账以美元为主 (订阅用户用 token/配额口径诚实展示);
- Phase 3 自动保护**缓行**, 只读承诺保持;
- GLM 网关支持保留为特性 (empirical TTL 估计是网关/OpenRouter 用户的差异化点), 不作主战场叙事;
- 依据: ccusage 18k★ vs 全部 keepalive 工具 ≤21★; 官方面板 (ZCode 命中率栏、Claude Code /cost) 只覆盖自家 harness 的浅层汇总; 差异化 = **深度** (状态/TTL/根因/账本) + **广度** (跨 agent) + **诚实性** (verified vs inferred)。

## 1. Phase 0 结论 (2026-08-19)

### 1.1 环境事实

- Claude Code **2.1.235**, Windows 10, Node 24;
- **该环境经 BigModel GLM 网关运行** (`ANTHROPIC_BASE_URL=open.bigmodel.cn/api/anthropic`, 模型 glm-4.7/5.1/5.2/5.3)。usage 遵循 Anthropic wire format, 但 TTL 行为由网关决定;
- JSONL 无官方 schema — 官方 monitoring 文档明示 transcript 格式 "internal to Claude Code, changes between versions"。

### 1.2 Schema 审计要点 (详见 docs/claude-code-schema.md)

- cache telemetry 在 `projects/<dir>/<sessionId>.jsonl` 的 assistant 记录 `message.usage`;
- **一个 API 响应 = 1~17 条记录** (实测 2548 条 → 885 message.id) → 必须按 message.id 去重;
- v2.1.235 新增大量 record type (queue-operation/atis-latch/last-prompt/…) → 未知类型跳过;
- `sessions/<pid>.json` 注册表是活跃 session 的首选信号, 但 updatedAt 只在事件时更新, 不能单凭它判死活;
- 时间戳非单调 (跨天 resume 交错); 文件 mtime 会被无时间戳的 bookkeeping 记录 (last-prompt) 刷新, **mtime ≠ 最近 API 调用**。

### 1.3 官方机制调研 (来源见 §6)

- context = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (官方 API 文档确认);
- TTL: 5m 默认 / 1h 可选; **读取免费刷新 TTL**; **寿命从请求开始算, 响应生成时间计入寿命**;
- 费率: cache read 0.1×, write 1.25×(5m)/2×(1h) 输入价; rate limit 口径: **read 不占 ITPM/RPM, write 计入 ITPM**;
- TTL 刷新: read **免费刷新** TTL, 5m 与 1h 档均适用 (1h 复用同样 "rolls the hour forward"); 寿命从请求开始计, 生成时间计入;
- `max_tokens:0` 已是**官方 pre-warming 功能** (2026-05-15): 读 prompt→写 cache→立即返回, 官方建议 "on a scheduled interval… at least every 5 minutes"; 约束: 不可与 stream/thinking/structured outputs/tool_choice 同用。ToS 无禁止 keepalive 条款 (2026-04 封禁的是"绕过缓存"的工具, 方向相反);
- **OpenAI/Codex 现行口径** (源码+文档核实): cached 折扣 **90% off (0.1×)**; TTL 双轨 — GPT-5.6+ 为 **30m 精确 TTL** (`prompt_cache_options.ttl='30m'`, 复用刷新不加写入费), 旧模型 in-memory 5-10m 或 extended retention 最长 24h (非 ZDR 组织 2026-05 起默认 24h); GPT-5.6 新增 **1.25× 写入加价** 与 `cache_write_tokens` 字段; Codex 本地 telemetry 在 `~/.codex/sessions/rollout-*.jsonl` 的 token_count 事件 (`cached_input_tokens` + `cache_write_input_tokens`) → CodexAdapter 可行; GLM Coding Plan **cached token 全额计配额、无折扣** → 本机环境是 cache 焦虑最尖锐的客群;
- 最小可缓存长度按模型 512~4096 tokens; 最多 4 个 cache breakpoint;
- Claude Code: 订阅默认请求 1h TTL, API key 默认 5m; subagent 恒 5m; 缓存 per 机器+目录; /compact、模型切换、MCP 连接断开等会破坏前缀;
- `cache_creation.ephemeral_{5m,1h}_input_tokens` 逐请求可解析 → TTL 档位运行时可见 (issue #46829 确认此字段可用于检测 TTL 档位变化);
- transcripts 约 30 天清理 (`cleanupPeriodDays`) → 必须自带持久存储 (已实现)。

### 1.4 同类项目调研 (来源见 §6)

| 项目 | 启示 |
|---|---|
| **ccusage** (~18k★, 2026-08-19; 仓库已迁 ccusage/ccusage 并转向 Rust 重写) | message.id 去重是社区标准; 但 keep-first 语义漏掉流式最终 output_tokens (#888); fork/sidechain 重复计数 (#897/#913)。CacheGuard: cache 字段在流式开始前即确定, keep-first 对 cache 字段无害 (本机数据验证重复记录数值一致) |
| Claude-Code-Usage-Monitor | "usage warehouse" 独立于 30 天清理的本地留存思路 (已采用) |
| claude-code-otel | OTEL 通道 (`claude_code.token.usage` 含 cacheRead/cacheCreation; api_request 事件含 duration_ms) — Phase 2 引入以获得延迟维度 |
| claude-code-cache-keepalive | 唯一现存 keepalive 实现 (Stop-hook + block decision), **无遥测无决策** — 正是 CacheGuard Phase 3 要补的层; 其 "读取刷新 TTL" 依赖目前是未文档化假设, 我们的观测数据可以验证它 |
| statusline countdown 类 | statusline 只在事件时刷新, 空闲时倒计时冻结 — 独立 CLI watch 是正确形态 |
| **TraceLab** (arXiv 2606.30560) | 定量论证: 总命中率 95.7% (Claude 95.8% / Codex 95.7%), 新用户消息轮 Claude 86.9% / 合计 84.4% / Codex 78.2%; 平均人类间隔 46.7min (中位 1.4min, P90 20.6min); **81% appended tokens 是冗余 re-prefill** (fresh 仅 19%), prefill amplification 5.3× (Claude 8.1× / Codex 3.9×); >5min gap 出现低命中率台阶, >1h 几乎全 miss |
| Copilot traces (arXiv 2608.00101) | idle <2min → >95% 命中, 2-10min → ~70% |

### 1.5 技术栈决策

**TypeScript + Node ≥22.5 + better-sqlite3 + commander**。理由与备选对比见 docs/architecture.md §10。关键驱动: 动态 schema 容错解析、跨平台 fs.watch、未来 VS Code Extension 复用 core。

### 1.6 本机实证 (Phase 1 假设的初步验证)

活跃 session (46MB, 885 个响应, 跨 ~8 天) 的时间序列显示:

- gap 64~500s: cache_read 保持高位 (如 gap=497s → cr=138,688) — **GLM 网关 TTL 明显 > Anthropic 官方 5m**;
- gap ≥ 550s 多次观测到近全 miss (cr → 256/384/1152 残量); 冷重建签名 cr=0 + cc=90,767;
- gap=84s 出现过 miss → 网关存在**负载相关逐出**, TTL 是分布而非常数 → 状态机必须永远 LIKELY_* + confidence。

## 2. Phase 1 验收清单 (原始成功标准逐条核对)

| # | 标准 | 状态 | 证据 |
|---|---|---|---|
| A | 自动找到 Claude Code session | ✅ | `cacheguard sessions` 列出全部真实 session |
| B | 识别当前活跃 session | ✅ | registry 优先 + mtime 兜底排序; 3 个 idle session 正确识别 |
| C | 实时读取新 telemetry | ✅ | watch 模式: tailer 增量 tail (fs.watch+poll), 半行缓冲, 截断重置; 测试覆盖 |
| D | 稳定恢复 cache read/write/timestamp/model/session | ✅ | parser 测试 + 真实 session 验证 (cr=128,576/cc/model 与手工审计一致) |
| E | 显示六种状态 | ✅ | VERIFIED_HIT/LIKELY_HOT/AT_RISK/LIKELY_EXPIRED/VERIFIED_MISS/UNKNOWN 全部实现且有测试 |
| F | 真实 idle-time experiment | ✅ | Phase 1.5 完成 (2026-08-19): headless 自执行, 25 步, 2h44m, 见 §5.5 |
| G | 所有状态可解释来源 | ✅ | 每个 estimate 带 reason (点名输入) + confidence + TTL 来源 |
| H | 只读, 不发请求 | ✅ | 代码零出站网络; 不写 ~/.claude 任何文件; 只写自有 ~/.cacheguard |

## 3. 发现的问题与处理 (原假设 vs 实际观察)

### P1 — 原假设: "5 分钟 TTL 倒计时"
实际: 本机走 GLM 网关, 实测存活可达 ~40min, 且有 84s 逐出。
处理: ProviderPolicy 四级来源 + EMPIRICAL_ESTIMATE (maxSurvived×0.8 haircut)。**原假设不成立于本机**, 设计已修正。

### P2 — 原假设: "JSONL 记录 ≈ API 调用"
实际: 一响应多条记录 (3x 放大)。
处理: message.id 去重 (内存 set + DB UNIQUE 约束双层)。

### P3 — 原假设: "文件 mtime/registry updatedAt = 最近活动"
实际: bookkeeping 记录 (last-prompt, 无时间戳) 会刷新 mtime; 展示的 "Last Call" 必须以最后 observation 时间戳为准 (诚实显示 311h)。
处理: 排序用 mtime/registry (识别"你在看哪个 session"), 状态显示用 observation 时间戳 (cache 事实)。

### P4 — 原假设: "相邻请求 miss = TTL 过期"
实际: 17s gap 的 miss 是前缀断裂 (并发请求/后台调用不同 prefix); context 骤降的 miss 是 compaction。
处理: 证据提取三重防护 (≥60s gap、context 缩水 <0.6 剔除、survived haircut)。修复前 b8f0de04 估出 TTL=42s 的荒谬值, 修复后正确降级为 UNKNOWN。

### P5 — costUSD 字段
调研发现新版本记录可能带 `costUSD`。当前未使用 (Phase 1 不算钱)。Phase 2 决策: 与 ccusage 相同的三模式 (trust/recalculate/auto)。

## 4. 未验证假设 (Phase 1.5 后更新)

1. ~~"读取刷新 TTL" 在 GLM 网关是否成立?~~ **✅ VERIFIED (2026-08-19)**: 40min+中点整读 → 100% 命中 vs 对照 MISS, 2/2 周期。周期 2 显示部分读触发的重写同样延续存活 → 对 keepalive 而言 "任何 touch 都延续"。
2. 网关 TTL 分布: 单点 MISS (40.2min) + 2/12 空闲探测出现 ~21.4k 部分层 → TTL/逐出是**分布而非常数**; 需 Phase 3 决策引擎按概率建模。未解: 21.4k 层的机制 (分层 checkpoint 假说)。
3. `ephemeral_5m/1h` 在网关下恒 0 — 网关不做档位区分 (实验中 23/23 观测均为 0)。基本可关闭此假设: RUNTIME_TELEMETRY 档位对 GLM 无意义。
4. watch soak 首份数据 ✅ (180min, 0 重启, 0 stderr, RSS ~68MB, CPU <0.05%); 高频写入日间 soak 仍待做 (audit §2.3.2: 挂真实工作日)。
5. ccusage #888 类问题: 同 message.id 后续记录 output_tokens 增长 — 本机未见差异; Phase 2 算钱时重新评估。

## 5. Phase 1.5 — Controlled Idle-Time Experiment (✅ 2026-08-19 完成)

方案 (使用一个真实 Claude Code session, 通过本工具观测):

1. 建立基线: 连续对话至 context > 30k tokens, 确认 VERIFIED_HIT;
2. 空闲阶梯: 1min / 3min / 5min / 8min / 12min / 20min / 40min 后各发一轮简单请求;
3. 每轮记录 (自动入库, 事后导出): idle gap / cache_read / cache_creation / input / output / 估计状态 vs 实测结果;
4. 产出 `experiments/cache-ttl-validation.md`, 回答: telemetry 是否稳定出现 / miss 是否在预期窗口 / EMPIRICAL_ESTIMATE 与实测的偏差 / 无法解释的观测。

### 5.5 执行结果 (详报: experiments/cache-ttl-validation.md)

- **执行**: headless `claude -p --resume` (干净 CLAUDE_CONFIG_DIR 通道, 网关 env 继承用户 settings), sanity 4/4 HIT; ctx 85.5k; 阶梯 [3,6,10,20,40]min + refresh 臂 G=40min ×2 周期; 1,357,559 tokens (硬上限 1.5M 内, 超 1M 目标 — bigfile 实测 62k 高于计划 22k)。
- **TTL 窗口**: 存活 20m07s (×3), 40m09s 全量 MISS (cr=64) → **GLM TTL ∈ (20.1, 40.2] min** (n=1 MISS 单点)。
- **读刷新 VERIFIED**: c1 (中点 100% 整读) 40m16s 处 100% 命中; c2 (中点 25% 部分+重写) 40m15s 处 100% 命中; 对照 40m09s MISS。
- **通道工程教训** (对复现实验重要): 用户配置下插件 memory 注入会在轮间漂移前缀 (attempt-1 r2 31.5%), alwaysThinking+xhigh 使 "ok" 产生 4 内部轮; 须用干净 config + `--max-turns 1`。
- **产品修复**: `--claude-dir` 覆盖时端点误判 STATIC_POLICY → 已修 (UNKNOWN/EMPIRICAL 降级 + 回归测试, 37 tests)。
- **新事实入库**: ~21.4k 部分层 (3 次复现)、跨 session 分叉 ~768 tok、GLM cc 恒 0、cr 多为 256 倍数。

### 5.6 Round 3: CodexAdapter 结论 (2026-08-20)

- **真实数据验证通过** (非合成): 本机 codex-cli 0.147, 2026-03~08 rollouts, 模型 gpt-5.4 / gpt-5.6-sol / gpt-5.6-luna。发现→解析→入库→六状态展示全链路在真实 session 上工作 (`status 019fdbc0` → gpt-5.6-sol STATIC 30m; `status 019cc743` → gpt-5.4 自身历史 EMPIRICAL 1169s)。
- **关键口径差异** (docs/codex-schema.md §4): OpenAI `input_tokens` **已包含** cached (total=input+output 实测精确成立) → contextTokens=input, 与 Anthropic 加法口径相反; 无 message.id 且 ordinal 缺失 → requestId=timestamp+input; pre-5.6 cache_write serde 缺省 0 → `cacheWriteUnknown` 标记。
- **新真实发现**: custom provider 下 GPT-5.6 的 cache_write 恒 0 而缓存明确增长 (cached 跨请求 +20k) → 写入侧遥测对 Codex custom provider 不可信, Phase 2 写入成本只能用 cached 差分近似。
- **工程**: policy 双分支 (GPT-5.6+ STATIC 30m / pre-5.6 UNKNOWN·EMPIRICAL); engine 多 agent 双发现; CLI `--codex-dir`; zstd 检测跳过 (合成测试); 58 测试全绿 (37→58, +21)。
- **npm 预检** (2026-08-20): `cacheguard` ✅ 可用 (E404), `cacheguard-cli` ✅ 可用, `cache-guard` ❌ 已被 caching.ai 占用。package.json 已整理 (description/keywords 双 agent; files 白名单 dist+README; bin 就绪)。**未发布** — 发布动作待用户指令。

## 6. 参考文献 (Phase 0 调研, 2026-08-19)

官方: [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [Messages API](https://docs.anthropic.com/en/api/messages) · [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching) · [Monitoring/OTEL](https://code.claude.com/docs/en/monitoring-usage) · [Statusline](https://code.claude.com/docs/en/statusline)

项目: [ccusage](https://github.com/ccusage/ccusage) (#389 #888 #897 #913) · [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) · [claude-code-otel](https://github.com/ColeMurray/claude-code-otel) · [claude-code-cache-keepalive](https://github.com/yujiachen-y/claude-code-cache-keepalive)

研究: TraceLab (arXiv 2606.30560) · Copilot traces (arXiv 2608.00101) · Continuum (arXiv 2511.02230, Hanchen Li 等) · [TTL regression issue #46829](https://github.com/anthropics/claude-code/issues/46829) (community-reported, 未被官方确认)

## 7. Phase 2 (Cost Engine) 预研结论

- 费率 (官方): cache read 0.1×、write 1.25×(5m)/2×(1h) 输入价; GLM Coding Plan **cached token 全额计配额、无折扣** (audit §1.5) → 本机环境下 Cost Engine 的核心是**配额账本** (每次 MISS = 全额重算 ~ctx tokens 配额), 而非美元;
- Verified vs Estimated Saving 分账规则: 只有 "保护后真实请求 telemetry 显示命中" 才计入 Verified; refresh 语义已 VERIFIED → Verified Saving 的因果链闭合可行;
- Keepalive 成本 = 一次 touch 请求的 ctx tokens (GLM 全额计配额); 决策式见原始愿景 §18, 逐出概率 (~21.4k 部分层现象) 需进入 P(存活) 项;
- 关键参数 (实测): TTL 窗口 (20.1, 40.2]min → touch 间隔应 ≤20min 且明显小于窗口上限; 更细的间隔优化待 Phase 2 建模。

## 8. 下一步 (优先级序)

1. ✅ Phase 1.5 idle experiment — **gate PASSED** (2026-08-19)
2. ✅ watch soak 首份数据 (180min 空闲 session); ⬜ 日间高频写入 soak (audit §2.3.2: 挂真实工作日)
3. ✅ git 初始化 + 首次提交; ⬜ 远程仓库 (发布前确认 npm `cacheguard` 包名, audit 注: `cache-guard` 已被 caching.ai 占用)
4. ⬜ Phase 2 Cost Engine 设计文档 (gate 已开; 逐出概率 + GLM 配额账本为一等输入; Codex 写入成本差分近似)
5. ⬜ OTEL 通道 spike (duration_ms 维度; audit §2.4.3)
6. ⬜ audit §2.3.3: 目标客群需求验证 (GLM/中转站社区投放 status 截图)
7. ⬜ 发布准备 (发布动作需用户指令): npm publish 前再查包名、README 双 agent 示例、GitHub 仓库与 CI
