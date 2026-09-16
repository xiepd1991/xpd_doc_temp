// 桥接插件实机验证夹具：复刻 opencode 的 $ (Bun shell) 最小接口，真实驱动插件钩子。
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const PYTHON = "C:\\Users\\13119\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe"

// Bun shell 的最小等价实现：支持 .cwd / .env / .stdin / .quiet / .nothrow，可 await
const $ = (strings, ...vals) => {
  const st = { cwd: process.cwd(), env: process.env, stdin: "", nothrow: false }
  const parts = []
  strings.forEach((s, i) => {
    parts.push(s)
    if (i < vals.length) parts.push(vals[i])
  })
  const api = {
    cwd(d) { st.cwd = d; return api },
    env(e) { st.env = e; return api },
    stdin(s) { st.stdin = s; return api },
    quiet() { return api },
    nothrow() { st.nothrow = true; return api },
    then(res, rej) { return exec().then(res, rej) },
  }
  function exec() {
    return new Promise((resolve, reject) => {
      // 复刻 shell 语义：按空白切分并剥离引号，再逐参数 spawn（不经过 shell）
      const argv = parts
        .map(String)
        .join("")
        .match(/"[^"]*"|\S+/g)
        .map((t) => t.replace(/^"|"$/g, ""))
      const p = spawn(argv[0], argv.slice(1), { cwd: st.cwd, env: st.env })
      let so = "", se = ""
      p.stdout.on("data", (d) => (so += d))
      p.stderr.on("data", (d) => (se += d))
      p.on("close", (code) => {
        const r = { exitCode: code, stdout: Buffer.from(so), stderr: Buffer.from(se) }
        if (code !== 0 && !st.nothrow) {
          const e = new Error("shell exited " + code)
          e.result = r
          reject(e)
        } else resolve(r)
      })
      p.stdin.end(st.stdin || undefined)
    })
  }
  return api
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}  (${detail})`)
}

;(async () => {
  const mod = await import("file:///C:/Users/13119/.config/opencode/plugins/dev-expert-bridge.js")
  const logs = []
  const client = {
    app: { log: async (a) => logs.push(`${a.body.level}: ${String(a.body.message).split("\n")[0]}`) },
  }

  const fx = path.join(process.env.TEMP || "/tmp", "de_bridge_test")
  fs.rmSync(fx, { recursive: true, force: true })
  fs.mkdirSync(path.join(fx, "src"), { recursive: true })
  fs.mkdirSync(path.join(fx, "vendor"), { recursive: true })
  fs.writeFileSync(path.join(fx, "src", "a.py"), "x=1\n")

  console.log("=".repeat(64))
  console.log("桥接插件行为验证（模拟 opencode 运行时）")
  console.log("=".repeat(64))
  console.log("夹具目录: " + fx)
  console.log()

  const hooks = await mod.DevExpertBridge({ $, directory: fx, worktree: fx, client })
  const names = Object.keys(hooks)
  check("插件注册钩子完备", names.includes("tool.execute.before") && names.includes("tool.execute.after"), names.join(" | "))
  console.log()

  console.log("场景 1: 写入 vendor/lib.js → guard_dirs.py 应阻断")
  try {
    await hooks["tool.execute.before"](
      { tool: "write" },
      { args: { filePath: path.join(fx, "vendor", "lib.js"), content: "a=1" } },
    )
    check("vendor 写入被阻断", false, "未抛异常")
  } catch (e) {
    const ok = /GUARD-BLOCK|拒绝写入/.test(String(e.message))
    check("vendor 写入被阻断", ok, String(e.message).split("\n")[0].slice(0, 72))
  }
  console.log()

  console.log("场景 2: 写入 src/a.py（项目无 Plan/）→ 应放行，且生成 .bak")
  try {
    // 先把目标文件内容改一下，确保 backup_on_write 有旧版本可备份
    await hooks["tool.execute.before"](
      { tool: "write" },
      { args: { filePath: path.join(fx, "src", "a.py"), content: "y=2\n" } },
    )
    check("src 写入放行", true, "未抛异常")
    const bak = path.join(fx, "src", "a.py.bak")
    check("backup_on_write 生成 .bak", fs.existsSync(bak), fs.existsSync(bak) ? "a.py.bak 已生成" : "缺失")
  } catch (e) {
    check("src 写入放行", false, String(e.message).split("\n")[0].slice(0, 72))
  }
  console.log()

  console.log("场景 3: 建立 Plan/ 且状态非进行中 → 应阻断")
  fs.mkdirSync(path.join(fx, "Plan"), { recursive: true })
  fs.writeFileSync(path.join(fx, "Plan", "t_plan.md"), "# 计划\n\n## 状态: 已完成\n")
  try {
    await hooks["tool.execute.before"](
      { tool: "edit" },
      { args: { filePath: path.join(fx, "src", "a.py"), oldString: "y=2", newString: "y=3" } },
    )
    check("Plan 体系下无进行中计划被阻断", false, "未抛异常")
  } catch (e) {
    const ok = /PLAN-GUARD|进行中的/.test(String(e.message))
    check("Plan 体系下无进行中计划被阻断", ok, String(e.message).split("\n")[0].slice(0, 72))
  }
  console.log()

  console.log("场景 4: Plan/ 状态改为进行中 → 应放行")
  fs.writeFileSync(path.join(fx, "Plan", "t_plan.md"), "# 计划\n\n## 状态: 进行中\n")
  try {
    await hooks["tool.execute.before"](
      { tool: "edit" },
      { args: { filePath: path.join(fx, "src", "a.py"), oldString: "y=2", newString: "y=3" } },
    )
    check("有计划时放行", true, "未抛异常")
  } catch (e) {
    check("有计划时放行", false, String(e.message).split("\n")[0].slice(0, 72))
  }
  console.log()

  console.log("场景 5: read 工具不应触发任何钩子")
  const before = logs.length
  await hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: path.join(fx, "src", "a.py") } })
  check("read 不触发钩子", logs.length === before, `新增日志 ${logs.length - before} 条`)
  console.log()

  console.log("场景 6: tool.execute.after 写后检查不应抛异常")
  try {
    await hooks["tool.execute.after"](
      { tool: "write" },
      { args: { filePath: path.join(fx, "src", "a.py") }, result: "ok" },
    )
    check("after 钩子不阻断主流程", true, "未抛异常")
  } catch (e) {
    check("after 钩子不阻断主流程", false, String(e.message).slice(0, 72))
  }
  console.log()

  console.log("=".repeat(64))
  const passed = results.filter((r) => r.ok).length
  console.log(`  ${passed}/${results.length} 通过`)
  console.log("=".repeat(64))
  if (logs.length) {
    console.log("\n插件产生的日志（前 8 条）:")
    logs.slice(0, 8).forEach((l) => console.log("  " + l.slice(0, 96)))
  }

  fs.rmSync(fx, { recursive: true, force: true })
  process.exit(passed === results.length ? 0 : 1)
})()
