#!/usr/bin/env node
/**
 * 生成 GitHub 主页统计图（纯 SVG）
 *   stats.svg / stats-dark.svg      —— 关注者、Star、Fork、仓库、提交、PR 与语言构成
 *   contrib.svg / contrib-dark.svg  —— 近一年贡献热力图（GitHub 贡献日历样式）
 *
 * 数据源：
 *   api.github.com  —— 用户信息、仓库、语言、提交/PR 计数（公开数据，无需 token）
 *   github.com      —— 贡献日历（解析 data-date / data-level，同样无需 token）
 *
 * 失败时回退到上一次的快照缓存，保证页面上的图不会消失。
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"

const USER = process.env.GH_USER || "qiuxi903"
const OUT_DIR = process.env.OUT_DIR || "assets"
const CACHE_FILE = process.env.CACHE_FILE || join(OUT_DIR, "stats-cache.json")
const API = "https://api.github.com"

const HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "qiuxi903-profile-stats",
}

const LANG_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Vue: "#41b883", Rust: "#dea584",
  Python: "#3572A5", Java: "#b07219", "C++": "#f34b7d", Kotlin: "#A97BFF",
  HTML: "#e34c26", CSS: "#563d7c", GLSL: "#5686a5", Lua: "#000080",
  Shell: "#89e051", Dockerfile: "#384d54", CMake: "#DA3434", PowerShell: "#012456",
  Batchfile: "#C1F12E", Go: "#00ADD8", C: "#555555", "C#": "#178600",
  Swift: "#F05138", PHP: "#4F5D95", Astro: "#ff5a03",
}

const THEMES = {
  light: {
    text: "#24292f", muted: "#57606a", subtle: "#8c959f",
    tile: "#f6f8fa", tileBorder: "#d0d7de", barTrack: "#eaeef2",
    title: "#24292f", divider: "#d8dee4",
    levels: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    gridBorder: "#d0d7de",
  },
  dark: {
    text: "#c9d1d9", muted: "#8b949e", subtle: "#6e7681",
    tile: "#161b22", tileBorder: "#30363d", barTrack: "#21262d",
    title: "#e6edf3", divider: "#30363d",
    levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    gridBorder: "#30363d",
  },
}

const FONT = "'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',-apple-system,BlinkMacSystemFont,system-ui,sans-serif"
const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',monospace"

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const fmt = (n) => {
  if (n === undefined || n === null) return "-"
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M"
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K"
  return String(n)
}

async function api(path) {
  const res = await fetch(API + path, { headers: HEADERS })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- ${path}`)
  return res.json()
}

/* ---------------------------------------------------------------- 数据采集 */

async function collectStats() {
  const user = await api(`/users/${USER}`)
  const repos = await api(`/users/${USER}/repos?per_page=100&sort=updated`)

  const stars = repos.reduce((a, r) => a + r.stargazers_count, 0)
  const forks = repos.reduce((a, r) => a + r.forks_count, 0)

  const langBytes = {}
  for (const r of repos) {
    if (!r.size) continue
    try {
      const langs = await api(`/repos/${r.full_name}/languages`)
      for (const [name, bytes] of Object.entries(langs)) {
        langBytes[name] = (langBytes[name] || 0) + bytes
      }
    } catch {
      /* 单个仓库失败不影响整体 */
    }
  }

  const search = async (q) => {
    try {
      const r = await api(`/search/${q}&per_page=1`)
      return r.total_count ?? 0
    } catch {
      return 0
    }
  }
  const [commits, prs, issues] = await Promise.all([
    search(`commits?q=author:${USER}`),
    search(`issues?q=author:${USER}+type:pr`),
    search(`issues?q=author:${USER}+type:issue`),
  ])

  const totalBytes = Object.values(langBytes).reduce((a, b) => a + b, 0) || 1
  const langs = Object.entries(langBytes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, bytes]) => ({
      name,
      color: LANG_COLORS[name] || "#8b949e",
      pct: (bytes / totalBytes) * 100,
    }))

  return {
    followers: user.followers,
    stars,
    forks,
    repos: repos.length,
    commits,
    prs,
    issues,
    langs,
  }
}

/**
 * 贡献日历数据：优先解析 JSON，其次解析 HTML 单元格
 * 两者都来自 https://github.com/users/<user>/contributions，无需 token
 */
async function collectContributions() {
  const url = `https://github.com/users/${USER}/contributions`
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  let lastErr
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; profile-stats)", Accept: "application/json, text/html" },
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) throw new Error(`contributions ${res.status} ${res.statusText}`)
      const text = await res.text()

      // 1) JSON 形态
      if (text.trim().startsWith("{")) {
        const data = JSON.parse(text)
        const days = (data.weeks || []).flatMap((w) =>
          (w.contributions || []).map((c) => ({ date: c.date, level: Number(c.level) || 0, count: c.count || 0 }))
        )
        if (days.length) return { days, total: data.totalContributions ?? days.length }
      }

      // 2) HTML 形态：<td data-date="..." data-level="N"> 后紧跟一个 tool-tip，内含当日贡献数
      const re = /data-date="(\d{4}-\d{2}-\d{2})"[^>]*data-level="(\d)"[\s\S]{0,600}?<\/td>\s*<tool-tip[^>]*>([^<]*)<\/tool-tip>/g
      const days = []
      let m
      while ((m = re.exec(text)) !== null) {
        const count = Number((m[3].match(/(\d+)\s+contribution/) || [])[1] || 0)
        days.push({ date: m[1], level: Number(m[2]) || 0, count })
      }
      if (!days.length) throw new Error("no contribution cells found")
      const total = days.reduce((a, d) => a + d.count, 0)
      return { days, total }
    } catch (err) {
      lastErr = err
      console.warn(`[contrib] attempt ${attempt} failed: ${err.message}`)
      if (attempt < 4) await sleep(2000 * attempt)
    }
  }
  throw lastErr
}

/* ---------------------------------------------------------------- 渲染：统计卡片 */

export function renderStats(data, variant) {
  const c = THEMES[variant]
  const W = 1000
  const PAD = 28

  const tiles = [
    { label: "关注者", value: fmt(data.followers) },
    { label: "Star", value: fmt(data.stars) },
    { label: "Fork", value: fmt(data.forks) },
    { label: "仓库", value: fmt(data.repos) },
    { label: "提交", value: fmt(data.commits) },
    { label: "PR", value: fmt(data.prs) },
  ]

  const TILE_H = 78
  const gap = 14
  const tileW = (W - PAD * 2 - gap * (tiles.length - 1)) / tiles.length
  const tilesY = 74
  const langTitleY = tilesY + TILE_H + 44
  const rowH = 26
  const langsY = langTitleY + 24
  const H = langsY + data.langs.length * rowH + 26

  const labelW = 116
  const barX = PAD + labelW
  const barMax = W - PAD - barX - 62

  const p = []
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="GitHub statistics for ${esc(USER)}">`)
  p.push(`<text x="${PAD}" y="40" font-size="26" font-weight="700" fill="${c.title}">${esc(USER)}</text>`)
  p.push(`<text x="${W - PAD}" y="38" font-size="13" fill="${c.subtle}" text-anchor="end">GitHub Statistics</text>`)
  p.push(`<line x1="${PAD}" y1="56" x2="${W - PAD}" y2="56" stroke="${c.divider}" stroke-width="1"/>`)

  tiles.forEach((t, i) => {
    const x = PAD + i * (tileW + gap)
    p.push(`<rect x="${x}" y="${tilesY}" width="${tileW}" height="${TILE_H}" rx="10" fill="${c.tile}" stroke="${c.tileBorder}" stroke-width="1"/>`)
    p.push(`<text x="${x + tileW / 2}" y="${tilesY + 40}" font-size="24" font-weight="700" fill="${c.text}" text-anchor="middle">${esc(t.value)}</text>`)
    p.push(`<text x="${x + tileW / 2}" y="${tilesY + 62}" font-size="12" fill="${c.muted}" text-anchor="middle">${esc(t.label)}</text>`)
  })

  p.push(`<text x="${PAD}" y="${langTitleY}" font-size="14" font-weight="600" fill="${c.text}">语言构成</text>`)
  if (!data.langs.length) {
    p.push(`<text x="${PAD}" y="${langsY + 16}" font-size="13" fill="${c.subtle}">暂无公开语言数据</text>`)
  }
  data.langs.forEach((l, i) => {
    const y = langsY + i * rowH
    const w = Math.max(2, (l.pct / 100) * barMax)
    p.push(`<text x="${PAD + labelW - 12}" y="${y + 13}" font-size="13" fill="${c.text}" text-anchor="end">${esc(l.name)}</text>`)
    p.push(`<rect x="${barX}" y="${y + 3}" width="${barMax}" height="14" rx="7" fill="${c.barTrack}"/>`)
    p.push(`<rect x="${barX}" y="${y + 3}" width="${w.toFixed(1)}" height="14" rx="7" fill="${l.color}"/>`)
    p.push(`<text x="${W - PAD}" y="${y + 13}" font-size="12" fill="${c.muted}" text-anchor="end">${l.pct.toFixed(1)}%</text>`)
  })
  p.push(`</svg>`)
  return p.join("\n")
}

/* ---------------------------------------------------------------- 渲染：贡献热力图 */

export function renderContrib(contrib, variant) {
  const c = THEMES[variant]
  const days = [...contrib.days].sort((a, b) => a.date.localeCompare(b.date))
  if (!days.length) throw new Error("empty contributions")

  const CELL = 11
  const PITCH = 14
  const LEFT = 34
  const TOP = 46
  const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

  // 以第一天为原点，按周对齐（周日为每行首日）
  const origin = new Date(days[0].date + "T00:00:00Z")
  const originDow = origin.getUTCDay() // 0=周日

  const cells = days.map((d) => {
    const dt = new Date(d.date + "T00:00:00Z")
    const diff = Math.round((dt - origin) / 86400000)
    const x = Math.floor((diff + originDow) / 7)
    const y = dt.getUTCDay()
    return { x, y, level: d.level, date: d.date }
  })

  const weeks = Math.max(...cells.map((c2) => c2.x)) + 1
  const gridW = weeks * PITCH - (PITCH - CELL)
  const W = LEFT + gridW + 8
  const gridH = 7 * PITCH - (PITCH - CELL)
  const H = TOP + gridH + 44

  const p = []
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="Contribution graph for ${esc(USER)}">`)

  // 标题
  p.push(`<text x="0" y="18" font-size="14" font-weight="600" fill="${c.text}">${fmt(contrib.total)} contributions in the last year</text>`)

  // 月份标签
  let lastMonth = -1
  let firstLabel = true
  for (const cell of cells) {
    const dt = new Date(cell.date + "T00:00:00Z")
    const m = dt.getUTCMonth()
    if (m !== lastMonth && cell.y === 0) {
      const x = LEFT + cell.x * PITCH
      if (x > LEFT + 14 || firstLabel) {
        p.push(`<text x="${firstLabel ? LEFT : x}" y="${TOP - 10}" font-size="11" fill="${c.subtle}">${MONTH_LABELS[m]}</text>`)
        firstLabel = false
      }
      lastMonth = m
    }
  }

  // 星期标签（Mon / Wed / Fri）
  const rows = [[1, "Mon"], [3, "Wed"], [5, "Fri"]]
  for (const [row, label] of rows) {
    p.push(`<text x="${LEFT - 8}" y="${TOP + row * PITCH + CELL - 2}" font-size="11" fill="${c.subtle}" text-anchor="end">${label}</text>`)
  }

  // 格子
  for (const cell of cells) {
    const x = LEFT + cell.x * PITCH
    const y = TOP + cell.y * PITCH
    const color = c.levels[Math.min(4, Math.max(0, cell.level))]
    p.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="3" fill="${color}"/>`)
  }

  // 图例（靠右，与 GitHub 贡献图一致）
  const legendY = TOP + gridH + 24
  const legendW = 30 + 5 * (CELL + 4) + 4
  const legendX = W - legendW - 30
  p.push(`<text x="${legendX}" y="${legendY + 11}" font-size="11" fill="${c.subtle}">Less</text>`)
  for (let i = 0; i < 5; i++) {
    p.push(`<rect x="${legendX + 30 + i * (CELL + 4)}" y="${legendY}" width="${CELL}" height="${CELL}" rx="3" fill="${c.levels[i]}"/>`)
  }
  p.push(`<text x="${legendX + 30 + 5 * (CELL + 4) + 4}" y="${legendY + 11}" font-size="11" fill="${c.subtle}">More</text>`)

  p.push(`</svg>`)
  return p.join("\n")
}

/* ---------------------------------------------------------------- 主流程 */

function hash8(str) {
  return createHash("sha256").update(str).digest("hex").slice(0, 8)
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  const cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {}
  const out = {}

  // 统计卡片
  try {
    const stats = await collectStats()
    out.stats = stats
    console.log("[stats] ok:", JSON.stringify({ ...stats, langs: stats.langs.length + " langs" }))
  } catch (err) {
    if (!cache.stats) throw err
    console.warn(`[stats] fetch failed (${err.message}), fallback to cache`)
    out.stats = cache.stats
  }

  // 贡献热力图
  try {
    const contrib = await collectContributions()
    out.contrib = contrib
    console.log(`[contrib] ok: ${contrib.days.length} days, total ${contrib.total}`)
  } catch (err) {
    if (!cache.contrib) {
      console.warn(`[contrib] fetch failed (${err.message}) and no cache, skip`)
    } else {
      console.warn(`[contrib] fetch failed (${err.message}), fallback to cache`)
      out.contrib = cache.contrib
    }
  }

  const files = {}
  const write = (name, content) => {
    writeFileSync(join(OUT_DIR, name), content)
    files[name] = hash8(content)
  }

  if (out.stats) {
    write("stats.svg", renderStats(out.stats, "light"))
    write("stats-dark.svg", renderStats(out.stats, "dark"))
  }
  if (out.contrib) {
    write("contrib.svg", renderContrib(out.contrib, "light"))
    write("contrib-dark.svg", renderContrib(out.contrib, "dark"))
  }

  // 缓存：只保留成功取到的部分
  const merged = { ...cache, ...out }
  writeFileSync(CACHE_FILE, JSON.stringify(merged, null, 2))

  console.log("[stats] written:", Object.keys(files).join(", "))
}

if (process.argv[1] && process.argv[1].endsWith("generate-stats.mjs")) {
  main().catch((err) => {
    console.error("[stats] failed:", err.message)
    process.exit(1)
  })
}