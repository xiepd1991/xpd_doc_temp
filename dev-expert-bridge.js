/**
 * dev-expert 桥接插件 — 把 opencode 的工具事件转接给 dev-expert 技能自带的 Python 钩子。
 *
 * 背景：dev-expert 的 22 个钩子全部依赖「宿主把工具调用 JSON 从 stdin 传入、
 * 用 exit 2 表示阻断」这一协议。opencode 没有该协议，只有插件钩子，
 * 本插件负责双向翻译，使零改造的 Python 钩子可直接复用。
 *
 * 协议映射：
 *   stdin  ->  由本插件组装 {tool_input:{filePath, content, oldString, newString}, tool_name, cwd, output}
 *   exit 0 ->  放行
 *   exit 1 ->  非阻断警告，stdout 透传给模型
 *   exit 2 ->  tool.execute.before 抛异常阻断；tool.execute.after 仅告警（已落盘，无法阻止）
 *
 * 部署：~/.config/opencode/plugins/dev-expert-bridge.js（全局）或 .opencode/plugins/（项目级）
 * 环境变量：
 *   DEV_EXPERT_SKILL_DIR  技能根目录（默认 ~/.claude/skills/dev-expert）
 *   DEV_EXPERT_PYTHON     Python 解释器（默认按 py -3 / python3 / python 探测）
 */

import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SKILL_DIR =
  process.env.DEV_EXPERT_SKILL_DIR || join(homedir(), ".claude", "skills", "dev-expert")
const HOOKS_DIR = join(SKILL_DIR, "hooks")

const PRE_HOOKS = ["backup_on_write.py", "guard_dirs.py", "plan_guard.py", "precheck_on_write.py"]

const POST_HOOKS = [
  "lint_on_write.py",
  "php8_compat.py",
  "java_compat.py",
  "security_scan.py",
  "secret_scan.py",
  "utf8_check.py",
  "debug_residue.py",
  "select_star.py",
  "dep_scan.py",
  "sql_injection_check.py",
  "cms_risk_check.py",
  "errors_recall_guard.py",
  "errors_dup_guard.py",
  "graph_impact.py",
  "memory_prune.py",
]

// 写入类工具名，对应本技能 matcher 里的 write_to_file|replace_in_file|Write|Edit
const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit", "write_to_file", "replace_in_file"])

/**
 * 探测 Python 解释器。优先级：
 *   1. DEV_EXPERT_PYTHON 环境变量（显式指定，跨机器最可靠）
 *   2. WorkBuddy / CodeBuddy 隔离运行时（扫描版本号目录，不写死版本）
 *   3. PATH 中的 py / python3 / python
 * 换机器时若全部落空，设 DEV_EXPERT_PYTHON 即可。
 */
function resolvePython() {
  if (process.env.DEV_EXPERT_PYTHON) return process.env.DEV_EXPERT_PYTHON

  const candidates = []
  for (const base of [".workbuddy", ".codebuddy"]) {
    const versionsDir = join(homedir(), base, "binaries", "python", "versions")
    if (!existsSync(versionsDir)) continue
    try {
      for (const v of readdirSync(versionsDir)) {
        candidates.push(join(versionsDir, v, "python.exe"))
        candidates.push(join(versionsDir, v, "bin", "python3"))
      }
    } catch {
      // 读取失败则跳过该基目录
    }
  }
  for (const p of candidates) {
    if (existsSync(p)) return p
  }

  return findOnPath(["py", "python3", "python"]) || "python"
}

/** 在 PATH 中查找可执行文件（不依赖 opencode 提供的 $，因为探测发生在插件初始化阶段）。 */
function findOnPath(names) {
  const dirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":").filter(Boolean)
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const full = join(dir, name + ext)
        if (existsSync(full)) return full
      }
    }
  }
  return ""
}

const PYTHON = resolvePython()

function resolveProjectRoot(directory, worktree) {
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT
  return worktree || directory || process.cwd()
}

function pickPath(args) {
  return args?.filePath || args?.file_path || args?.path || args?.file || ""
}

async function runHook($, script, payload) {
  const scriptPath = join(HOOKS_DIR, script)
  if (!existsSync(scriptPath)) {
    return { exitCode: 0, stdout: "", stderr: "", missing: true }
  }
  const env = { ...process.env, PROJECT_ROOT: payload.cwd }
  try {
    const res =
      await $`${PYTHON} ${scriptPath}`.cwd(payload.cwd).env(env).stdin(JSON.stringify(payload)).quiet().nothrow()
    return {
      exitCode: res.exitCode ?? 0,
      stdout: (res.stdout?.toString() ?? "").trim(),
      stderr: (res.stderr?.toString() ?? "").trim(),
      missing: false,
    }
  } catch (err) {
    // 钩子自身异常绝不影响主流程（对齐技能「任何失败均放行」原则）
    return { exitCode: 0, stdout: "", stderr: String(err), missing: false }
  }
}

export const DevExpertBridge = async ({ $, directory, worktree, client }) => {
  if (!existsSync(HOOKS_DIR)) {
    await client?.app?.log?.({
      body: { service: "dev-expert-bridge", level: "warn", message: `未找到 hooks 目录: ${HOOKS_DIR}` },
    })
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (!WRITE_TOOLS.has(String(input.tool || "").toLowerCase())) return
      const filePath = pickPath(output.args)
      if (!filePath) return

      const payload = {
        tool_name: input.tool,
        cwd: resolveProjectRoot(directory, worktree),
        tool_input: {
          filePath,
          content: output.args?.content ?? output.args?.newString ?? "",
          oldString: output.args?.oldString ?? "",
          newString: output.args?.newString ?? "",
        },
      }

      const blocks = []
      for (const script of PRE_HOOKS) {
        const r = await runHook($, script, payload)
        if (r.exitCode === 2) {
          blocks.push(r.stdout || `[${script}] 已阻断（无输出）`)
        } else if (r.stdout) {
          await client?.app?.log?.({
            body: { service: "dev-expert-bridge", level: "info", message: r.stdout },
          })
        }
      }
      if (blocks.length) {
        // 首行给出摘要，便于 UI 单行折叠显示时仍可读
        const detail = blocks.join("\n")
        const summary = detail.split("\n")[0].replace(/^\[([A-Z-]+)\]\s*/, "")
        throw new Error(`dev-expert 前置校验未通过：${summary}\n${detail}`)
      }
    },

    "tool.execute.after": async (input, output) => {
      if (!WRITE_TOOLS.has(String(input.tool || "").toLowerCase())) return
      const filePath = pickPath(output.args)
      if (!filePath) return

      const payload = {
        tool_name: input.tool,
        cwd: resolveProjectRoot(directory, worktree),
        tool_input: { filePath },
        tool_response: output.result ?? output.output ?? "",
        output: output.result ?? output.output ?? "",
      }

      const warnings = []
      for (const script of POST_HOOKS) {
        const r = await runHook($, script, payload)
        if (r.stdout) warnings.push(r.stdout)
      }
      if (warnings.length) {
        await client?.app?.log?.({
          body: {
            service: "dev-expert-bridge",
            level: "warn",
            message: `dev-expert 写后检查：\n${warnings.join("\n")}`,
          },
        })
      }
    },

    // 对应技能 PreCompact -> handoff_snapshot.py（落 .ai-memory/handoff.md 检查点）
    "experimental.session.compacting": async (input, output) => {
      const r = await runHook(
        $,
        "handoff_snapshot.py",
        { cwd: resolveProjectRoot(directory, worktree), tool_input: {} },
      )
      if (r.stdout) output.context?.push?.(r.stdout)
    },

    // 对应技能 capture_learning.py（错误/纠错信号捕获）
    event: async ({ event }) => {
      if (event?.type !== "session.idle") return
      const cwd = resolveProjectRoot(directory, worktree)
      for (const script of ["capture_learning.py", "errors_dup_guard.py"]) {
        const r = await runHook($, script, { cwd, tool_input: {} })
        if (r.stdout) {
          await client?.app?.log?.({
            body: { service: "dev-expert-bridge", level: "info", message: r.stdout },
          })
        }
      }
    },
  }
}
