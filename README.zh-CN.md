# CacheGuard

> **让 Coding Agent 的 Prompt Cache 看得见、算得清、值得时才保护。**
> 面向 Claude Code 与 Codex 的只读 Prompt Cache 观测工具。本地优先、零网络、诚实的数字。

*(英文主文档见 [README.md](README.md); 本文件为中文对照, 数字与能力声明以英文版为准。)*

## 为什么

LLM 服务商用 Prompt Cache 避免每轮重新 prefill 全部历史。但 cache 有 TTL 与逐出策略 — 你在 Agent 完成任务后阅读代码、思考的每一分钟, 都在消耗 cache 的寿命。下次输入时大段前缀重新 prefill: 更贵、更慢, 而这一切对用户完全不可见。

TraceLab 对真实 Claude Code/Codex 工作负载的测量 ([arXiv 2606.30560](https://arxiv.org/abs/2606.30560)): prefix cache 总命中率 95.7%, 但**新用户消息轮只有 86.9%** (Claude 口径; 合计 84.4%); 追加 token 中 **81% 是冗余 re-prefill**; 人类平均响应间隔 **46.7 分钟** (中位 1.4min) — 远超常见 TTL。

## 命令

```bash
cacheguard status      # 当前 cache 状态 (六状态模型 + TTL 倒计时 + 可解释 reason)
cacheguard watch       # 实时刷新
cacheguard cost        # 经济账本: verified bleed / 节省 / 冷重建暴露 (双账本, 永不混同)
cacheguard doctor      # miss 归因诊断: 证据链建议, metadata-only
cacheguard sessions    # 跨双 agent 列出 session
cacheguard backfill    # 全量解析入库
```

所有命令支持 `--json`; `--claude-dir` / `--codex-dir` 覆盖数据目录。

### 状态栏集成 (每一轮都看得见)

Claude Code 官方 statusline 机制会在每次 UI 事件时调用你配置的命令 — 官方支持通道, 无 JSONL 漂移风险。在 `~/.claude/settings.json` 加入:

```json
{
  "statusLine": {
    "type": "command",
    "command": "cacheguard statusline"
  }
}
```

输入框下方即得紧凑状态行, 如:

```
♻ 97% · TTL 2m14s · bleed $0.45
⏳ 99% · TTL 41s · bleed 381k tok   (配额模式, 如 GLM 网关)
✗ 97% · TTL expired
```

设计要点: 只读 1MB 会话尾部 (管线 P95 ≈ 5ms), 不读写数据库; 无遥测时输出中性的 `cacheguard: no telemetry`, 绝不报错刷屏。Codex 无此机制, 仅限 Claude Code。

## 诚实性原则 (与官方统计栏的差异点)

我们观察不到 GPU 上的 KV cache — 所以绝不假装。每个数字带认知级别:

- **VERIFIED_HIT / VERIFIED_MISS** — 由真实请求遥测证明 (事实);
- **LIKELY_HOT / AT_RISK / LIKELY_EXPIRED** — 推断, 永远带 confidence 与点名输入的 reason;
- **verified bleed** — 只由已证明的 MISS/PARTIAL 事件产生的 "多花了多少";
- **estimated** — 前瞻估算, 带假设说明; **inferred** — 展示但永不并入 verified 汇总;
- **UNKNOWN** — 无证据则无数字; 无牌价的网关只出 token 账, 绝不造美元。

TTL 永不写死: Anthropic 5m/1h 与 OpenAI GPT-5.6 30m 仅在官方文档适用处生效; 网关 (GLM/OpenRouter/…) 降级为你自己历史数据的 EMPIRICAL 估计, 或诚实标注 UNKNOWN。

## 隐私承诺

- **零网络** — 代码中不存在任何出站 HTTP;
- **不读对话内容** — parser 只解析 token 计数/时间戳/模型名, 物理上不读正文;
- **对 agent 只读** — 不写 `~/.claude` 与 `~/.codex`, 自有数据在 `~/.cacheguard`;
- agent 本地数据约 30 天清理, CacheGuard 的账本独立留存历史。

## 支持状态

| Agent | TTL 策略 | 验证 |
|---|---|---|
| Claude Code | Anthropic 5m/1h; 网关 → EMPIRICAL/UNKNOWN | 真实 session + 受控 idle 实验 (GLM: TTL ∈ (20,40]min, 读刷新 VERIFIED) |
| Codex CLI | GPT-5.6+ = 30m; pre-5.6 = UNKNOWN + EMPIRICAL | 真实 session (gpt-5.4 / gpt-5.6) |

## 已知局限

- Codex 写入侧遥测不可靠 (pre-5.6 缺省 0; 部分网关恒 0) → bleed 恒为下界, inferred 加价单列;
- 费率是手工内置快照 (带日期); 未核验牌价的模型只出 token 账; GLM 为配额口径;
- JSONL 无官方 schema 保证 → 双 parser 容错 + 版本入库对冲;
- 归因是启发式 (suspected-*/inferred), 不宣称因果;
- 网关 TTL 表现为分布 (负载逐出), 倒计数为估计值。

## Roadmap

observe ✅ / cost ✅ / doctor ✅ / 归因深化 ⬜ / 更多 Agent (Cursor/OpenCode) ⬜ / **keepalive 明确缓行 — 仅在验证值得后才会做 (opt-in)**。

## 开发

```bash
npm install && npm run build && npm test    # 87 测试
npm run schema-audit                        # 重新审计本机 agent schema
```

文档: [架构](docs/architecture.md) · [Claude Code schema](docs/claude-code-schema.md) · [Codex schema](docs/codex-schema.md) · [Cost Engine](docs/cost-engine.md) · [Doctor](docs/doctor.md) · [开发计划](docs/development-plan.md)

## License

Apache-2.0
