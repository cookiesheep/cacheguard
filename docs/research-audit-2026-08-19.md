# CacheGuard 独立事实复核与竞争审计 (2026-08-19)

> 项目总脑第一轮 Independent Research & Project Audit。
> 方法：5 条并行调研线（TraceLab 论文原文 / Anthropic 官方文档 / OpenAI+Codex 官方文档与源码 / GitHub 竞品代码级审计 / HN-Reddit-中文社区市场信号），全部结论带来源，核验日期均为 2026-08-19。
> 事实层级标注： [A]=官方文档 [B]=本机实验 [C]=第三方研究(论文) [D]=开源项目/社区 [E]=假设。

---

## 1. 事实核验结果总表

### 1.1 TraceLab 论文 (arXiv 2606.30560) — [C] 可信度高

论文真实存在：*TraceLab: Characterizing Coding Agent Workloads for LLM Serving*，华盛顿大学 SyFI 组 (Kan Zhu 等， 含 Baris Kasikcri / Arvind Krishnamurthy)，v1 2026-06-29 / v2 2026-06-30。代码与数据集已开源 (github.com/uw-syfi/TraceLab, Apache-2.0, 93★)，发表一个月被引 6 次（含微软 Copilot 生产 trace 论文）。

| 项目内引用 | 核验结果 |
|---|---|
| 全局 prefix cache 命中率 95.7% | ✅ 正确 (Table 11: Claude 95.8% / Codex 95.7%) |
| 新用户消息轮命中率 Claude 84.4% | ❌ **84.4% 是 Claude+Codex 合计值；Claude 单独是 86.9%** (Codex 78.2% 正确) |
| 81% 追加 token 冗余 re-prefill | ✅ 正确 (fresh 仅 19.0%) |
| 人类响应间隔 mean 46.7min / median 1.4min | ✅ 正确 (Table 7; P90=20.6min, P99=13.9h) |
| 每 token 平均 prefill ~5 次 | ⚠️ 论文口径是 **prefill amplification 5.3×** (Claude 8.1× / Codex 3.9×)，数学等价但引用时应写明口径 |
| 12.8% 成本上界 | ✅ 存在且确为 upper bound： 总 priced cost 最多**降低** 12.8% ($40,431→$35,242, 省 $5,189; Claude 16.2% / Codex 8.5%)。计价模型 = 官方牌价 + cache read 按 0.1× + 被削 token 全按 cache-read 价结算 → 不可达理论上界 |
| 5 分钟阈值 | ✅ "gap >5min 后低命中率 step 开始出现；>1h 几乎全 miss" (经验结论) |
| 作者是否提出 refresh | ✅ §7.6: "Agent harnesses can periodically refresh the cache during long human-thinking gaps" — 无 keepalive 字样但明确提议 |

修正项： "CacheTTL (arXiv 2511.02230)" 实为 **Continuum** (Hanchen Li 等, 含 Ion Stoica) — 引用名需改。Copilot traces (arXiv 2608.00101) 属实： idle <2min 命中 ≥95%， 2-10min 降至 ~70%， >10min 基本 miss。

### 1.2 Anthropic 官方 — [A]

| 声称 | 结果 |
|---|---|
| 5m 默认 / 1h opt-in TTL | ✅ |
| read 0.1× / write 1.25×(5m) / 2×(1h) | ✅ (现行价格表全部精确符合) |
| **cache read 免费刷新 TTL** | ✅ 官方原文: "The cache is refreshed for no additional cost each time the cached content is used"，5m 与 1h 均适用 |
| TTL 从请求开始计，生成时间计入寿命 | ✅ 官方 Troubleshooting 原文确认 (provider-policy.ts 的 haircut 设计方向正确) |
| `max_tokens:0` | ✅ **已升级为官方 pre-warming 功能** (2026-05-15 release notes): 读入 prompt→写 cache→立即返回，官方明确建议 "on a scheduled interval… at least every 5 minutes"。约束： 不可与 stream/thinking/structured outputs/tool_choice 同用 |
| 4 usage 字段 (cache_read/cache_creation/ephemeral_5m/1h) | ✅ 官方 SDK 类型确认 |
| 最小可缓存长度 512~4096 / 4 breakpoints | ✅ (新旗舰 Opus5/Fable5/Mythos5 为 512，多数主力 1024) |
| cache 不占 rate limit | ⚠️ 精确化： **read 不占 ITPM/RPM；write 计入 ITPM** |
| keepalive 政策 | ✅ **官方鼓励** scheduled pre-warm；ToS/Usage Policy 未发现禁止条款。2026-04 Anthropic 封禁的是"绕过缓存"的第三方工具，方向相反 |
| Claude Code 行为 (订阅 1h / API key 5m / subagent 恒 5m / per 机器+目录 / /compact、切模型、MCP 重连破坏前缀) | ✅ 官方逐条确认。补充: `ENABLE_PROMPT_CACHING_1H=1` / `CLAUDE_CODE_CACHE_STRATEGY` 可覆盖 |
| JSONL transcript 官方 schema | ⚠️ 官方明示: 本地格式 "not officially supported for integrations, may change at any time… only hints"。**OTel 才是官方支持通道** |

### 1.3 OpenAI / Codex — [A + 源码]

| 声称 | 结果 |
|---|---|
| 自动缓存 ≥1024 tokens | ✅ (GPT-5.6 起为严格 1024；早期模型 1024~2048) |
| TTL "5-10min / off-peak 1h" | ❌ **过时**。现行双轨: GPT-5.6+ = **30 分钟精确 TTL** (`prompt_cache_options.ttl='30m'`，复用刷新不加写入费)；GPT-5.6 之前 = in-memory 5-10min **或 extended retention 最长 24h**（gpt-5.x 系支持，**非 ZDR 组织 2026-05 起默认 24h**） |
| cached 折扣 50%/75% | ❌ 现行 GPT-5.x/codex 系一律 **90% off (0.1×)**；GPT-5.6 系新增 **1.25× 写入加价**（与 Anthropic 同型） |
| `cached_tokens` | ✅ 官方字段 |
| `cache_write_tokens` | ✅ **真实字段** (GPT-5.6+，Responses API `input_tokens_details` 内) |
| Codex 本地 telemetry | ✅ **`~/.codex/sessions/rollout-*.jsonl` 的 token_count 事件含 `cached_input_tokens` + `cache_write_input_tokens`** (serde 定义核实，`#[serde(default)]` 旧模型缺省 0)。无官方格式文档，schema 以源码 serde 为准。CodexAdapter 可行 |
| Codex cache 需求实证 | ✅ issue #35925: 用户用本地 token_count 记录重建 HIT/MISS 并与 Azure 计费精确对账 (miss 占一次 $210 session 未缓存成本的 94%)；另有 #35300/#37305/#30425 等活跃 issue |
| keepalive 政策 | ✅ 无禁止；唯一指引： 同 key 流量 ~15 req/min 以内 |

### 1.4 竞争格局 — [D]

| 项目 | Star | 活跃 | 定位 | 威胁 |
|---|---|---|---|---|
| **caching.ai** (caching-ai/caching.ai) | **1** | 08-04 | 功能最全: Hono proxy (Anthropic/OpenAI/Gemini/Grok) + 实测驱动 warmer (5m 档每 4min ping、长 hold 改 1h write 更省) + SHA-256 breaker 检测 + verified net savings 计费 (20% 抽成) + CC 插件 | 功能高 / 市场零 traction |
| **claude-code-cache-fix** | **418** | 08-15 | 本地 proxy 修 --resume 缓存回归 + 监控；赛道心智王 | 高 (可扩张方向) |
| ccusage | **18,033** | 今天 | 用量统计 only，无 cache 分析 | 低 (但证明"看见"类工具能赢) |
| opencode-visual-cache | 266 | 今天 | OpenCode 侧缓存可视化标杆 | OpenCode 侧中 |
| Efs-O/CacheWarden | 1 | 08-12 | VS Code ext，CC+Codex，fork-session 保活 | 思路完整无用户 |
| aider --cache-keepalive-pings | (仓库 48.3k) | 05-22 | 进程内 295s 周期 max_tokens=1 ping | 低 |
| claude-code-cache-keepalive (yujiachen-y) | 16 | 04-14 弃更 | Stop hook sleep 240s + block | 低 |
| claude-code-coffee | 6 | 05-09 | 纯 prompt skill + CC cron | 低 |
| cwarm (fifthadj) | 0 | 08-17 | PTY 注入 + ephemeral 实测 TTL | 低 |
| stoke / wirescope | 4 / 1 | 07-30 / 08-16 | 与 caching.ai 概念同构的新入场者 | 中 |
| Anthropic 官方 | — | 持续 | **无内置 keepalive**；v2.1.91 起 /cost cache 细分、过期 footer 提示、miss 归因、resume/subagent/LSP 修复等 30+ 条 cache changelog | **最高 (原生化)** |

注意: **npm `cache-guard` 包名已被 caching.ai 占用** (0.1.1)；`cacheguard` (无连字符) 可用性发布前需确认。

### 1.5 市场信号 — [C/D]

- 痛真实且 2026-04~08 持续发酵: HN 759 分 (Pro Max 5x 配额 1.5h 耗尽) / 706 分 (CC 先发 33k token) / 240 分 402 评论 (官方质量回应)。官方成员确认: 闲置 >1h 后消息 = 全量 miss，"吃掉 rate limit 显著百分比"。
- 痛的主次: ① 订阅用户配额烧损 (最多) ② API 用户真金白银 (冷启动 $2-9/次， miss 比 hit 贵 ~12.5×) ③ 延迟 (次要)。
- 订阅配额与 cache 挂钩 [A]: 官方 costs 文档确认缓存 token 计入限额 (read/write 各有折扣口径)；**GLM Coding Plan cached token 全额计配额、无折扣** (r/ZaiGLM 多帖抱怨 + 官方文档自述命中率 90.9~98%) → GLM 订阅用户 cache 焦虑最尖锐。
- keepalive 工具被市场证伪: 全赛道 ≤21★、Show HN 2 分、零用户证言、Grov (193★) 已转型。ccusage 18k★ 证明用户要的是**看见/归因**，不是**保温**。
- 中文社区讨论质量高 (V2EX 31 回复帖、知乎/腾讯云实测文) 但集中在"看懂账单改用法"，无工具化；中转站生态有 cached_tokens 透传丢失问题。
- 原生化时间线: 可见性/归因 2026-04~08 已原生化；miss 根因修复密集落地中；TTL 上限仍 1h (4 月一度收缩→5 月修复)。**"保温"逆官方 roadmap；跨 provider 可见性+省配额分析窗口约 12-24 个月。**

---

## 2. 认知校准结论

### 2.1 需要修正的旧结论 (已定位到文件)

1. `README.md:37` + `docs/development-plan.md §1.4`: "新用户消息轮只有 84.4%" → **Claude 86.9% / 合计 84.4% / Codex 78.2%**
2. 同处 "每 token 平均被 prefill ~5 次" → 改为 "prefill amplification 5.3× (Claude 8.1×)"
3. `docs/development-plan.md §6`: "CacheTTL (arXiv 2511.02230)" → **Continuum**
4. `docs/development-plan.md §1.4`: ccusage "~14k★" → 18k★ (2026-08-19)
5. OpenAI 认知更新: 折扣 90% (非 50%/75%)；TTL 双轨 (GPT-5.6 30m 精确 / 旧模型最长 24h retention、非 ZDR 默认 24h)；GPT-5.6 有 1.25× 写入加价与 `cache_write_tokens`
6. "cache 命中不占 rate limit" → "read 不占 ITPM/RPM，**write 计入 ITPM**"
7. `max_tokens:0` 从"存在的 API 能力"升级为"**官方 pre-warming 功能 + 官方鼓励定时刷新**"(2026-05-15)
8. ProviderPolicy 的 ANTHROPIC 静态策略注释可补: 1h TTL 复用同样刷新 ("rolls the hour forward")

### 2.2 战略判断

**产品定位微调** (slogan 三段保留，第三段内涵修正):

> CacheGuard — 让 Coding Agent 的 Prompt Cache 看得见、算得清、**值得时才保护**。

- **看得见**是主产品 (市场已证明: ccusage 18k vs keepalive ≤21)。但 Anthropic 官方端点的"看见"正被原生化收编 → 我们的"看见"主战场: **非官方端点 (GLM/OpenRouter/中转站) + 多 agent (Codex/Cursor/OpenCode) + 跨 session 长期账本 (JSONL 30 天即清)**。
- **算得清**是差异化核心 (Verified vs Estimated 分账，全赛道无人做对)。
- **自动做**收窄为 economics-aware: 仅对 API 计费用户与全额计配额网关 (GLM 类) 划算；Anthropic 官方订阅用户 (1h TTL + read 折扣计额) 的正确产品是 observe+explain+advise，不是 ping。Phase 3 决策引擎必须把"用户计费模式"作为一等输入。

**值得做的判断: 值得，但重心已校准。** 依据: ① 痛点有 759/706/240 分 HN 级证据; ② 竞品审计显示空白明确 (local-first 信任 + 完整经济模型无桥梁); ③ 本机 GLM 环境本身就是最尖锐目标客群; ④ Phase 1 只读路线与市场证据完全一致，无需返工。风险对冲: 不押注 Anthropic 官方端点的 keepalive。

**最大竞争风险**: Anthropic 原生化 (每周 ~1 条 cache changelog) — 对冲 = 网关/多 agent/长期账本。
**最大技术风险**: JSONL 无官方 schema 保证 (官方原话"may change at any time") — 对冲 = 已实现的容错 parser + version 入库 + OTel 适配器作为官方通道备份。
**最大产品风险**: 保温价值反事实不可感知 — 对冲 = Verified Saving 分账账本 (Phase 2 核心)。

### 2.3 Phase 1.5 之后的三道验证门 (当前最优先)

1. **Idle-time 对照实验** (dev plan §5 已设计，补充一臂): 阶梯 gap 1/3/5/8/12/20/40min ×3 重复，外加 **refresh 语义臂** — 同样 8min gap，一组中点插入一次探测请求、一组不插，对比命中 → 直接回答"GLM 网关上 read 是否刷新 TTL"(Phase 3 可行性门)。
2. **Schema 漂移生存测试**: watch 挂真实工作日 + Claude Code 升级一次后回归 (36 测试 + 真实 session)。OTel 通道 1 天 spike 评估作为官方备份通道的成本。
3. **目标客群需求验证**: GLM Coding Plan / 中转站用户社区 (r/ZaiGLM、V2EX、baizhi 论坛) 投放 status 截图与说明，看是否有人要安装 (痛点帖已存在，缺的是工具帖)。

### 2.4 给开发 Agent 的下一轮任务 (按优先级)

1. 文档事实修正 (§2.1 清单，半天)。
2. Phase 1.5 实验: 实现 `experiments/` 记录脚本 + 执行含 refresh 臂的阶梯协议 + 产出 `experiments/cache-ttl-validation.md` (回答: telemetry 稳定性 / miss 是否落在预期窗口 / EMPIRICAL_ESTIMATE 偏差 / refresh 语义 / 无法解释的观测)。**禁止**: 任何 keepalive 自动化、写 ~/.claude、联网。
3. npm 包名可用性确认 (`cacheguard`) + OTel 通道 spike (只读评估，产出可行性笔记)。

---

## 3. 来源清单 (节选)

- TraceLab: arxiv.org/abs/2606.30560 · github.com/uw-syfi/TraceLab · tracelab.cs.washington.edu
- Anthropic: platform.claude.com/docs/en/build-with-claude/prompt-caching · /api/rate-limits · /release-notes (2026-05-15) · code.claude.com/docs/en/prompt-caching · /monitoring-usage · /costs
- OpenAI/Codex: developers.openai.com/api/docs/guides/prompt-caching · /pricing · /changelog · github.com/openai/codex (rollout/protocol serde) · issues #35925 #35300 #37305
- 竞品: github.com/caching-ai/caching.ai · cnighswonger/claude-code-cache-fix (418★) · ccusage (18,033★) · Hotakus/opencode-visual-cache (266★) · Efs-O/CacheWarden · carloluisito/stoke · avirtual/wirescope
- 市场: news.ycombinator.com/item?id=47739260 (759分) · 48883275 (706分) · 47878905 (240分) · 47880089 (官方回应) · r/ZaiGLM 配额帖 · V2EX t/1234919
