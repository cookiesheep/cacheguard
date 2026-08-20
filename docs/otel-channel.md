# OTel Channel Spike — 结论: 暂缓 (defer)

> 2026-08-20 · 有界 spike (一天内) · 产出为结论, 非产品代码

## 实验设置

- 本机 claude-code **2.1.235** (pinned 旧二进制 — 当天自动更新到的 2.1.236 在本机 segfault, 连 `--version` 都崩; 详见 dev plan 环境风险注记), GLM 网关 (`ANTHROPIC_BASE_URL=open.bigmodel.cn`), headless `-p` 模式, 独立 `CLAUDE_CONFIG_DIR`;
- 环境变量按官方 monitoring 文档: `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER`, 分别试 `console` (默认 60s 间隔 + 1s 间隔) 与 `otlp` (指向本地 dummy HTTP collector `127.0.0.1:14318`);
- 探测 3 次 (总计 ~260k quota tokens), 日志存于 `experiments/logs/otel-console-probe*.log` 与 `otlp-dummy-result.json`。

## 结果 (全部为实测, 非推断)

| 实验 | 结果 |
|---|---|
| console exporter, 默认间隔 | **零 telemetry 输出** (stdout 仅 `-p` 结果 JSON, stderr 仅无害警告) |
| console exporter, `OTEL_METRIC_EXPORT_INTERVAL=1000` + `OTEL_LOG_EXPORT_INTERVAL=1000` | **零输出** |
| otlp exporter → 本地 dummy collector (1s 间隔) | **零 POST 到达** (collector 无任何请求) |

即: 在本机配置 (第三方网关端点 + headless) 下, telemetry 管线**完全不发射**, 与 exporter 选择无关。疑似门控: 非官方端点或 headless 模式 (本地无法区分是哪一个; 官方文档未说明此门控)。

## 意外收获: 不需要 OTel 的延迟数据来源

`claude -p --output-format json` 的结果行**自带**逐请求延迟与用量:

```json
{ "duration_api_ms": 7387, "ttft_ms": 7704, "ttft_stream_ms": 757,
  "time_to_request_ms": 361, "duration_ms": 7731,
  "usage": {...含 cache_read/cache_creation...},
  "modelUsage": { "glm-5.2": { ..., "costUSD": 0.422896 } } }
```

- 含 TTFT 维度 (`ttft_ms`/`ttft_stream_ms`) — 这是 JSONL 观测不到的;
- `modelUsage.costUSD` 逐请求给出官方成本 (Cost Engine 的 official 来源!);
- 局限: 只存在于被包装调用的 stdout, **不落 JSONL** — 被动观测 (watch/status) 拿不到; 适合实验编排器 (Phase 1.5 的 run-idle-experiment 正是这样拿到 duration 的)。

## 建议: **暂缓建适配器** (不建 / 不弃)

理由:

1. **目标用户拿不到**: 我们的主战场 (GLM/OpenRouter/网关用户) 正是 telemetry 不发射的配置 — 为它建适配器服务不了差异化人群;
2. **启用摩擦大**: 需 3~5 个环境变量 + console/collector 二选一; ccusage 类工具的零配置体验是我们的对标;
3. **JSONL 备份价值未到触发点**: parser 已是版本容错 + version 入库, schema 漂移生存测试 (audit §2.3.2) 未做前不值得为备份通道投入;
4. **延迟需求有更便宜来源**: 包装调用的 stdout 结果行已验证可拿到 duration/TTFT/costUSD (上节样本)。

**重启条件** (任一满足即重评): ① 主打 Anthropic 原生端点用户; ② 官方改 JSONL 格式致 parser 失效且修复代价 > 适配器; ③ 有证据表明网关端点上 OTel 可用。届时若 console exporter 可用, 最小读取器 < 半天 (JSON 行解析, 无新依赖)。

## 用户启用成本参考 (若未来文档化)

官方路径: `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_METRICS_EXPORTER=otlp|console|prometheus` + (otlp 时) `OTEL_EXPORTER_OTLP_ENDPOINT/PROTOCOL` + 可选 cardinality/隐私 flag (`OTEL_LOG_USER_PROMPTS` 默认关)。至少 2 个变量, 实际可用 3~5 个 — 摩擦显著高于 "装完即用"。
