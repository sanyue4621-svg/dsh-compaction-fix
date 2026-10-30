#!/usr/bin/env node
// 重新生成「标准模式」预设覆盖：从当前安装包的 asar 里抽出最新的
// presets/standard.patch.yml，给 compaction-basic 套上参数，替换 profile patch 里那一段。
//
// 支持的 DSH 版本：桌面版 0.1.x – 0.2.x（实测 0.2.1-rc.3 / Electron 44.7.0）。
// 原理是从 asar 归档里读文件，跟版本号无关；但内置预设的 plugins 列表会随版本变，
// 所以换版本后必须重跑本脚本，不要直接抄旧的 cordis.patch.yml。
//
// 用法：
//   node 重新生成预设.mjs
//   node 重新生成预设.mjs --asar "D:\path\to\app.asar"     # 手动指定安装包
//   node 重新生成预设.mjs --profile "C:\Users\me\.dsh\profiles\desktop"
//
// 跑完重启 DSH。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------- 可调参数 ----------
const 参数 = {
  thresholdRatio: 0.3, // 估算阈值：0.3 = 估算 30 万触发（100 万窗口 ≈ 实际 60%）
  retainTokens: 100000, // 压完保留的估算 token 数；小窗口会冲突，见 README 硬约束
  auto: true,
}

// ---------- 找路径 ----------
function 找asar() {
  const 候选 = [
    process.env.DSH_ASAR,
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, 'DeepSeek Harness', 'resources', 'app.asar'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
    '/opt/DeepSeek Harness/resources/app.asar',
    '/usr/lib/deepseek-harness/resources/app.asar',
  ].filter(Boolean)
  for (const p of 候选) if (fs.existsSync(p)) return p
  throw new Error('找不到 app.asar，请用 --asar 指定')
}

function 找profile() {
  const 家 = os.homedir()
  const 候选 = [
    path.join(家, '.dsh', 'profiles', 'desktop'),
    path.join(家, '.dsh', 'profiles', 'web'),
  ]
  for (const p of 候选) if (fs.existsSync(p)) return p
  throw new Error('找不到 .dsh profile 目录，请用 --profile 指定')
}

const argv = process.argv.slice(2)
function 取参(名) {
  const i = argv.indexOf('--' + 名)
  return i >= 0 ? argv[i + 1] : undefined
}

const 安装包 = 取参('asar') || 找asar()
const profile目录 = 取参('profile') || 找profile()
const 补丁 = path.join(profile目录, 'cordis.patch.yml')
if (!fs.existsSync(补丁)) throw new Error('没有 cordis.patch.yml：' + 补丁)
const 备份目录 = path.join(profile目录, 'backup')

console.log('安装包：', 安装包)
console.log('profile：', profile目录)

// ---------- 从 asar 读文件 ----------
// asar = 16 字节头 + JSON 目录树 + 文件数据；数据起点是 8 + headerSize（不是 16）。
function 读asar(归档, 相对路径) {
  const fd = fs.openSync(归档, 'r')
  try {
    const 头 = Buffer.alloc(16)
    fs.readSync(fd, 头, 0, 16, 0)
    const 头长 = 头.readUInt32LE(4)
    const json长 = 头.readUInt32LE(12)
    const jb = Buffer.alloc(json长)
    fs.readSync(fd, jb, 0, json长, 16)
    const 树 = JSON.parse(jb.toString('utf8'))

    let 节点 = 树
    for (const 名 of 相对路径.split('/').filter(Boolean)) {
      节点 = 节点.files && 节点.files[名]
      if (!节点) throw new Error('asar 里没有：' + 相对路径)
    }
    if (节点.files) throw new Error('这是目录不是文件：' + 相对路径)

    const 偏移 = 8 + 头长 + Number(节点.offset)
    const 缓冲 = Buffer.alloc(节点.size)
    fs.readSync(fd, 缓冲, 0, 节点.size, 偏移)
    return 缓冲.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

const 预设相对路径 = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
const 源 = 读asar(安装包, 预设相对路径)
console.log('抽到标准模式：', 源.length, '字节')

// ---------- 改 plugins 段 ----------
const 行 = 源.split('\n')
const 起 = 行.findIndex((l) => /^\s*plugins:\s*$/.test(l))
if (起 < 0) throw new Error('标准模式里没找到 plugins:')

const 插件行 = []
for (let i = 起 + 1; i < 行.length; i++) {
  const l = 行[i]
  if (l.trim() === '') continue
  // 原文件里 plugins 子项缩进 10 格；覆盖层要 6 格，所以统一减 4
  插件行.push(l.startsWith('    ') ? l.slice(4) : l)
}

const 结果 = []
for (let i = 0; i < 插件行.length; i++) {
  const l = 插件行[i]
  结果.push(l)
  if (/-\s*id:\s*compaction-basic\s*$/.test(l)) {
    结果.push(插件行[++i]) // name 那行
    结果.push('            config:')
    结果.push('              # 由 重新生成预设.mjs 生成于 ' + new Date().toISOString().slice(0, 10))
    结果.push('              thresholdRatio: ' + 参数.thresholdRatio)
    结果.push('              retainTokens: ' + 参数.retainTokens)
    结果.push('              auto: ' + 参数.auto)
  }
}

const 新段 = [
  '# DSH compaction fix — 覆盖「标准模式」预设，只改压缩参数。',
  '#   config 是全量替换，所以 plugins 必须整段给（下面按当前安装包生成）。',
  '#   想撤掉就把整块删掉（到 agent-default-model 之前）。',
  '- id: preset-standard',
  "  name: '@deepseek-ai/dsh-agent-preset'",
  '  config:',
  '    id: standard',
  '    order: 1',
  '    plugins:',
  ...结果,
]

// ---------- 替换 profile patch 里的旧段 ----------
const 旧 = fs.readFileSync(补丁, 'utf8')
const 旧行 = 旧.split('\n')
const 段起 = 旧行.findIndex(
  (l) => l.includes('按 id 覆盖内置的「标准模式」预设') || l.includes('DSH compaction fix — 覆盖'),
)
const 段止 = 旧行.findIndex((l) => /^- id: agent-default-model/.test(l))
if (段起 < 0 || 段止 < 0 || 段止 <= 段起) {
  throw new Error(
    '在 profile patch 里没找到可替换的那一段（需要有 preset-standard 段，且后面跟着 - id: agent-default-model）',
  )
}

fs.mkdirSync(备份目录, { recursive: true })
const 备份名 = path.join(备份目录, 'patch-' + Date.now() + '.yml')
fs.writeFileSync(备份名, 旧, 'utf8')

const 出 = [...旧行.slice(0, 段起), ...新段, ...旧行.slice(段止)]
fs.writeFileSync(补丁, 出.join('\n'), 'utf8')

console.log('')
console.log('✅ 写好：', 补丁)
console.log('   旧 patch 备份：', 备份名)
console.log('   压缩参数：', JSON.stringify(参数))
console.log('   现在重启 DSH 生效。')
