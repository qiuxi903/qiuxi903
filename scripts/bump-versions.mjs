#!/usr/bin/env node
/**
 * 为 README 中的图片引用追加内容哈希版本号（?v=xxxx）
 *
 * 作用：图片内容一旦变化，URL 随之变化，浏览器与 CDN 的旧缓存自动失效，
 * 打开主页时看到的永远是最新生成的图。
 *
 * 图片通过 GitHub Pages 提供（缓存 10 分钟），国内访问可达；
 * 不使用相对路径，因为 GitHub 会把相对路径 302 到 raw.githubusercontent.com（国内不可达）。
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"

const ASSETS = process.env.ASSETS_DIR || "assets"
const README = process.env.README_FILE || "README.md"
const BASE = process.env.PAGES_BASE || "https://qiuxi903.github.io/qiuxi903/assets"

const hash8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8)

const hashes = {}
for (const name of readdirSync(ASSETS)) {
  if (!name.endsWith(".svg")) continue
  hashes[name] = hash8(readFileSync(join(ASSETS, name)))
}

let md = readFileSync(README, "utf8")
let changed = 0

const pattern = /(?:\.\/assets\/|https:\/\/qiuxi903\.github\.io\/qiuxi903\/assets\/)([a-z0-9-]+\.svg)(\?v=[a-f0-9]+)?/g

md = md.replace(pattern, (all, name) => {
  const h = hashes[name]
  if (!h) return all
  const next = `${BASE}/${name}?v=${h}`
  if (next !== all) changed++
  return next
})

writeFileSync(README, md)
console.log(`[bump] updated ${changed} image reference(s)`)
for (const [name, h] of Object.entries(hashes)) console.log(`[bump]   ${name} -> ${h}`)
