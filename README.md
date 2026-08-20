# CacheGuard

> **See your coding agent's prompt cache — before it expires.**
> Read-only prompt-cache observability for Claude Code and Codex. Local-first, zero network, honest numbers.

When you step away from a coding agent to read code or think, its prompt cache is quietly dying. Come back after the TTL and the entire conversation is re-prefilled from scratch — slower, and charged at full input price. You never see any of it.

TraceLab's measurement of real Claude Code / Codex workloads ([arXiv 2606.30560](https://arxiv.org/abs/2606.30560)) puts numbers on this: 95.7% of prefill could be served from cache overall, but **81% of appended tokens are still redundant re-prefill**, and human turn gaps average **46.7 minutes** (median 1.4 min) — far beyond typical cache TTLs.

CacheGuard makes the invisible visible, quantified, and honest.

## What it looks like

**`cacheguard status`** — is the cache alive right now? (real session, Codex CLI)

```
CacheGuard — read-only cache observability

Agent          Codex 0.146.0-alpha.9.2
Session        019fdbc0-9ee2-79b3-ac7d-d7e19c4afe1f
Model          gpt-5.6-sol

Context        209,015 tok
Cache Read     195,712 tok
Cache Write         0 tok
Cache Ratio      93.6%

Last Call      18h55m ago
Last Cache     18h55m ago (verified hit: 195,712 tok)
TTL Remaining  expired (est.) [STATIC_POLICY]

Cache State    LIKELY_EXPIRED
Confidence     83%

Reason: Last verified cache hit 18h55m (195,712 tokens read), 18h55m ago —
beyond the estimated TTL (STATIC_POLICY: 1800s). No new request has verified either way.
```

**`cacheguard cost`** — what did cache misses actually cost? (same session)

```
CacheGuard cost — pricing snapshot 2026-08-20
Agent          codex  gpt-5.6-sol

Requests       593 (full session file)
Input (unc.)   72,856,681 tok
Cache Read     70,155,136 tok
Prefill Spend  $48.59 [snapshot]
Cache Saving   $315.70 vs no-cache world

Cache Bleed (verified): $3.98  — 6 MISS/PARTIAL events
  2026/8/13 21:10:22  $0.61      suspected TTL · lower bound
  2026/8/13 21:20:38  $0.66      suspected TTL · lower bound
  …
Cold Exposure  $0.94 [estimated]
```

**`cacheguard doctor`** — *why* did it miss? (real Claude Code session via GLM gateway)

```
CacheGuard doctor — attribution diagnosis (metadata-only)

Verified bleed 11,544,789 tok across 73 MISS/PARTIAL event(s)

Attribution breakdown
  39   suspected TTL (suspected/inferred)
  22   compaction (suspected/inferred)
  7    suspected prefix break (suspected/inferred)
  4    model switch (suspected/inferred)

Model switches at miss boundaries
  2026/7/8 16:23:50  glm-5.1 → glm-5.2
  2026/8/19 17:52:07  glm-5.2 → glm-5.3

Recurring residual layers
  ×18  … ~21,646 tok sub-prefix readable while the bulk was lost (inferred)
  ×8   … ~45,264 tok …
  … 10 more clusters (see --json)

Advice (each tied to evidence; all conclusions are inferences)
  • [suspected-ttl] evidence: 39 miss(es) after idle gaps ≥60s …
```

## Honesty is the product

Nobody can see the KV cache on the provider's GPUs — so CacheGuard never pretends to. Every number carries its epistemic level, and facts are never mixed with inferences:

| Level | Meaning | Where you see it |
|---|---|---|
| `VERIFIED_HIT` / `VERIFIED_MISS` | Proven by real request telemetry (`cache_read_input_tokens`) | facts |
| `LIKELY_HOT` / `AT_RISK` / `LIKELY_EXPIRED` | Inference from last fact + time + TTL policy — always with confidence and a reason naming its inputs | state panel |
| `verified` bleed | Only from proven MISS/PARTIAL events: "this request cost X more than a full hit would" | cost ledger |
| `estimated` exposure | "if the cache died right now, the next request would cost X" — with its assumption printed | cost ledger |
| `inferred` write surcharge | Displayed, never summed into verified totals | cost ledger |
| `UNKNOWN` | No evidence → no number. Gateways without list prices get token-only ledgers; countdowns are marked as placeholders | everywhere |

TTL is never hardcoded: static policy (Anthropic 5m/1h, OpenAI GPT-5.6 30m) applies only where documented; gateways (GLM, OpenRouter, …) fall back to *empirical* estimates from your own session history, or honestly say `UNKNOWN`.

## Supported agents

| Agent | Source | TTL policy | Verified against |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | Anthropic 5m/1h docs; gateways → empirical/UNKNOWN | real sessions incl. a controlled idle experiment (GLM gateway: TTL ∈ (20, 40] min, read-refresh verified) |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | GPT-5.6+ → documented 30m; pre-5.6 → UNKNOWN (5–10min vs 24h retention cannot be distinguished locally) + empirical | real sessions (gpt-5.4, gpt-5.6) |

## Install & quickstart

Requires Node.js ≥ 22.5 and existing Claude Code or Codex local data.

> **Install note:** cacheguard depends on `better-sqlite3`, which runs a native install script. If your npm prompts about unapproved install scripts (npm ≥ 11 with allow-scripts), run `npm approve-scripts better-sqlite3` (or use `--ignore-scripts=false`) — a prebuilt binary is downloaded for common platforms, no toolchain needed.

```bash
npm install -g cacheguard
cacheguard status                # cache state of your most recent session
cacheguard cost                  # the economic ledger (verified bleed / savings / exposure)
cacheguard doctor                # why the misses happened, with evidence
cacheguard watch                 # live TTL countdown
cacheguard sessions              # list sessions across both agents
```

`--json` on every command. `--claude-dir` / `--codex-dir` override data locations.

## Privacy (a promise, not a setting)

- **Zero network.** There is no outbound HTTP anywhere in the code. Telemetry never leaves your machine.
- **No conversation content.** CacheGuard parses token counters, timestamps, and model names — the parsers physically do not read message bodies. Nothing you typed or generated is stored.
- **Read-only on your agents.** It never writes to `~/.claude` or `~/.codex`; it keeps its own small SQLite at `~/.cacheguard`.
- Local data is pruned by the agents after ~30 days; CacheGuard's ledger preserves your cache history independently.

## Known limitations (the honest list)

- **Codex write-side telemetry is unreliable** — `cache_write_input_tokens` defaults to 0 on pre-GPT-5.6 models and stays 0 on some providers even when writes happen. Codex bleed is therefore always a *lower bound*, with the inferred surcharge shown separately.
- **Pricing is a hand-vendored snapshot** (`src/cost/pricing-snapshot.json`, dated). Models without a verified list price get token-only ledgers — CacheGuard never invents dollar figures. GLM/gateway sessions run in quota mode (tokens, not USD).
- **Session JSONL has no official schema.** Both parsers are defensive (unknown records skipped, version logged per row) — but agent updates can change formats.
- **Attribution is heuristic.** Doctor buckets are `suspected-*` by design; recurring-layer findings are `inferred`. Nothing claims causation without telemetry proof.
- **TTL behaves like a distribution on gateways** (load-dependent eviction observed on GLM). Countdowns are estimates, labeled as such.

## Roadmap

- ✅ **Observe** — status / watch, six-state model, both agents
- ✅ **Calculate** — dual ledger (verified bleed / estimated exposure), pricing snapshot, quota mode
- ✅ **Diagnose** — doctor: attribution signals, recurring layers, evidence-tied advice
- ⬜ Attribution deepening & per-day ledgers
- ⬜ More agents (Cursor, OpenCode — adapter interface is ready)
- ⏸ **Auto-protect / keepalive — deliberately deferred.** We will only build it if the economics prove worth it (and it will be opt-in). CacheGuard stays read-only until then.

## Development

```bash
npm install && npm run build && npm test    # 87 tests
npm run schema-audit                        # re-audit your local agent schemas
```

Docs: [architecture](docs/architecture.md) · [Claude Code schema](docs/claude-code-schema.md) · [Codex schema](docs/codex-schema.md) · [cost engine](docs/cost-engine.md) · [doctor](docs/doctor.md) · [development plan](docs/development-plan.md)

中文文档: [README.zh-CN.md](README.zh-CN.md)

## License

Apache-2.0
