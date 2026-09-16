# dev-expert 迁移到 opencode

## 已完成的迁移

技能本体已 1:1 复制到 opencode 可识别的 Claude 兼容路径（opencode 与 Claude Code 共用）：

```
C:\Users\13119\.claude\skills\dev-expert\
├── SKILL.md          （name=dev-expert，与目录名一致）
├── references/       （45 个 md，按需 Read）
├── hooks/            （25 个 py，经桥接插件调用）
└── scripts/          （build_graph.py / init_deploy.py / hooks.json 等）
```

源目录 `C:\Users\13119\.workbuddy\skills\dev-expert__skillhub\` 保持不变，两边可共存。

## 桥接插件

`C:\Users\13119\.config\opencode\plugins\dev-expert-bridge.js`

opencode 没有「stdin 喂 JSON / exit 2 阻断」的钩子协议，插件负责翻译：

| dev-expert 原协议 | opencode 插件钩子 |
| --- | --- |
| `PreToolUse` → exit 2 阻断 | `tool.execute.before` 抛异常 |
| `PostToolUse` → exit 1 告警 | `tool.execute.after` 写日志 |
| `PreCompact` | `experimental.session.compacting` |
| `capture_learning.py` | `event: session.idle` |

环境变量（可选覆盖）：

- `DEV_EXPERT_SKILL_DIR` — 技能根目录，默认 `~/.claude/skills/dev-expert`
- `DEV_EXPERT_PYTHON` — Python 解释器，默认自动探测（见下）
- `PROJECT_ROOT` — 由插件按 `worktree` → `directory` 顺序自动注入

Python 探测顺序：`DEV_EXPERT_PYTHON` → `~/.workbuddy/binaries/python/versions/*`
→ `~/.codebuddy/...` → PATH 中的 `py` / `python3` / `python`。
不写死版本号，换机器时若全部落空，设 `DEV_EXPERT_PYTHON` 即可。

**跨机器部署**见同目录 `跨机器部署清单.md`。

## 使用前置条件

1. **必须安装 opencode 本体**（当前本机尚未安装，`~/.config/opencode` 下只有本插件）。
2. **Python ≥ 3.8**：本机 PATH 中无 `python` / `py`，插件会自动探测到
   `C:\Users\13119\.workbuddy\binaries\python\versions\3.13.12\python.exe`。
3. **包隔离**：该 Python 属 WorkBuddy 隔离运行时，`pip` 安装同样隔离。
   `build_graph.py`（项目知识图谱）若需第三方依赖，须单独建 venv。
4. **技能本体零外部依赖**：全仓 grep 验证无任何本机绝对路径，
   可整体拷到其他机器直接使用（详见随附的 `跨机器部署清单.md`）。

## init_deploy.py 的坑（务必注意）

**不要在没有项目标记的目录下裸跑 `init_deploy.py`。**

`detect_root()` 上溯找不到 `.git` / `.claude` / `.ai-memory` 等标记时，会回退成
「当前工作目录的父目录」。在家目录下运行会把「项目根」误判为 `C:\Users\13119`，
进而把 22 条钩子写进家目录的 `.claude\settings.json` 和 `.codebuddy\settings.json`。

实测对照：

| 命令 | 判定的项目根 | 写入目标 |
| --- | --- | --- |
| `init_deploy.py`（无 --root，在家目录） | `c:\Users\13119` ❌ | 家目录配置 |
| `init_deploy.py --root <真实项目>` | `<真实项目>` ✅ | 项目内配置 |

**结论：始终显式带 `--root`。**

另外，`init_deploy.py` 内建的工具探测表（CodeBuddy / Trae / Cursor / Claude Code /
Windsurf）**不含 opencode**，因此它无法自动为 opencode 部署钩子 —— opencode 的
钩子必须走本目录的桥接插件。

## 验证记录

钩子层（真实驱动 Python 钩子，10/10 通过）：

- `guard_dirs.py`：写 `vendor/` → exit 2 阻断；写 `src/` → exit 0 放行
- `plan_guard.py`：`Plan/` 状态「已完成」→ exit 2 阻断；「进行中」→ 放行；
  `## 状态` 换行写「规划中」→ 放行；`tests/` 目录 → 不拦
- `backup_on_write.py`：写前生成 `.bak`，内容与原文一致
- `secret_scan.py`：命中硬编码凭证 → 输出 `[SECRET-WARN]`
- `lint_on_write.py` / `utf8_check.py` / `debug_residue.py`：非阻断，exit 0
- 空 payload → 全部静默放行（容错性）

插件层（模拟 opencode 运行时，8/8 通过）：

- 注册钩子完备：`tool.execute.before` / `after` / `experimental.session.compacting` / `event`
- 写 `vendor/` 被阻断，错误消息含 `[GUARD-BLOCK]` 原文
- 写 `src/`（无 `Plan/`）放行，且生成 `.bak`
- `Plan/` 状态「已完成」被阻断，含 `[PLAN-GUARD]` 原文
- `Plan/` 状态改「进行中」后放行
- `read` 工具不触发任何钩子（零噪声）
- `tool.execute.after` 不阻断主流程

## 未验证项

- **opencode 是否真能发现该技能**：本机未装 opencode，无法实测。
  Claude 兼容路径加载机制与 Claude Code 是否完全一致，需装好后确认。
- **`$`（Bun shell）调用形式**：插件已改用无内联引号的
  `` $`${PYTHON} ${scriptPath}` `` 写法（Bun 自动处理含空格路径的引用）。
  验证夹具用等效 shell 语义模拟，未经 Bun 真机验证。
- **`client.app.log` 的日志可见性**：未确认在 opencode TUI 中的呈现效果。
