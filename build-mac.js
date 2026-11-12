'use strict'

// 手工组装 macOS .app 包（在 Windows 上交叉构建，无需 Mac）。
//
// .app 本质是固定结构的目录：
//   Token Plan.app/
//     Contents/
//       Info.plist          ← 应用元信息（名称/版本/图标/入口）
//       MacOS/              ← 可执行文件（Electron 的二进制）
//       Resources/          ← 图标 + 我们的 app.asar
//       Frameworks/         ← Electron 原有框架（解压自带）
//
// 解压 Electron 官方 zip 得到现成的 Electron.app，改名 + 换图标 + 塞入 asar 即可。
//
// 用法: node build-mac.js
// 产物: dist/Token Plan-mac-x64.zip / dist/Token Plan-mac-arm64.zip

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = __dirname
const DIST = path.join(ROOT, 'dist')
const APP_NAME = 'Token Plan'
const APP_VERSION = '1.0.0'

// ---------- zip 解压（用系统 tar，Windows 10+ 自带且支持 zip） ----------

function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  // Windows 自带 bsdtar，能解 zip；--force-local 防止 C:\ 被当成远程主机
  execFileSync('tar', ['--force-local', '-xf', zipPath, '-C', destDir], { stdio: 'pipe' })
}

// ---------- Info.plist 生成 ----------

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>Token Plan</string>
	<key>CFBundleIconFile</key>
	<string>icon.icns</string>
	<key>CFBundleIdentifier</key>
	<string>com.tokenplan.widget</string>
	<key>CFBundleName</key>
	<string>Token Plan</string>
	<key>CFBundleDisplayName</key>
	<string>Token Plan</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${APP_VERSION}</string>
	<key>CFBundleVersion</key>
	<string>${APP_VERSION}</string>
	<key>LSMinimumSystemVersion</key>
	<string>10.15.0</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.utilities</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSSupportsAutomaticGraphicsSwitching</key>
	<true/>
	<key>LSUIElement</key>
	<false/>
</dict>
</plist>
`
}

// ---------- 组装单个架构 ----------

function buildArch(arch) {
  const workDir = path.join(DIST, `_mac_${arch}`)
  const electronZip = path.join(ROOT, 'assets', `electron-mac-${arch}.zip`)

  if (!fs.existsSync(electronZip)) {
    console.error(`缺少 ${electronZip}，请先下载 Electron darwin-${arch} zip`)
    process.exit(1)
  }

  console.log(`[${arch}] 解压 Electron...`)
  fs.rmSync(workDir, { recursive: true, force: true })
  unzip(electronZip, workDir)

  const srcApp = path.join(workDir, 'Electron.app')
  const destApp = path.join(workDir, `${APP_NAME}.app`)

  // Electron.app → Token Plan.app（同目录移动，实质是改名）
  fs.renameSync(srcApp, destApp)

  const contents = path.join(destApp, 'Contents')
  const macosDir = path.join(contents, 'MacOS')
  const resourcesDir = path.join(contents, 'Resources')

  // 1) 可执行文件改名（Info.plist 里 CFBundleExecutable 指向它）
  const oldBin = path.join(macosDir, 'Electron')
  const newBin = path.join(macosDir, APP_NAME)
  fs.renameSync(oldBin, newBin)

  // 2) 图标
  fs.copyFileSync(path.join(ROOT, 'assets', 'icon.icns'), path.join(resourcesDir, 'icon.icns'))
  // Electron 自带 electron.icns，删掉避免混淆
  const oldIcon = path.join(resourcesDir, 'electron.icns')
  if (fs.existsSync(oldIcon)) fs.rmSync(oldIcon, { force: true })

  // 3) 我们的代码 → app.asar
  //    electron-builder 已生成含最新代码的 asar（win-unpacked 里的），直接复用
  const asarSrc = path.join(DIST, 'win-unpacked', 'resources', 'app.asar')
  if (!fs.existsSync(asarSrc)) {
    console.error('缺少 win-unpacked/resources/app.asar，请先跑一次 Windows 打包')
    process.exit(1)
  }
  // 移除默认 app 目录（如果有），用 asar 替代
  const defaultApp = path.join(resourcesDir, 'default_app.asar')
  if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp, { force: true })
  fs.copyFileSync(asarSrc, path.join(resourcesDir, 'app.asar'))

  // 4) Info.plist
  fs.writeFileSync(path.join(contents, 'Info.plist'), infoPlist())

  // 5) 清掉辅助工具里指向 Electron 名字的过时引用（保留文件，Mac 端运行时自会处理）
  console.log(`[${arch}] .app 组装完成: ${destApp}`)

  // 6) 打 zip（保留 .app 的目录权限结构；用 tar 转 zip 由外层脚本做）
  return destApp
}

// ---------- 主流程 ----------

fs.mkdirSync(DIST, { recursive: true })

for (const arch of ['x64', 'arm64']) {
  buildArch(arch)
}

console.log('\n全部完成。下一步用 tar 生成 zip（保持可执行权限）：')
console.log('  tar -a -cf "dist/Token Plan-mac-x64.zip" -C dist/_mac_x64 "Token Plan.app"')
console.log('  tar -a -cf "dist/Token Plan-mac-arm64.zip" -C dist/_mac_arm64 "Token Plan.app"')
