'use strict'

const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// 启动探针：在任何可能失败的代码之前先写一条 boot 记录，
// 打包版有问题时（没有终端可看）能据此判断是在哪一步挂掉的。
const BOOT_MARK = (() => {
  try {
    const dir = path.join(app.getPath('appData'), 'TokenPlanWidget')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'boot.log')
    const line = `[${new Date().toISOString()}] boot v${process.versions.electron} packaged=${app.isPackaged} pid=${process.pid}\n`
    fs.appendFileSync(file, line, 'utf8')
    return file
  } catch {
    return null
  }
})()

function bootLog(msg) {
  if (!BOOT_MARK) return
  try {
    fs.appendFileSync(BOOT_MARK, `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
  } catch { /* ignore */ }
}

process.on('uncaughtException', (error) => {
  bootLog('uncaughtException: ' + (error && error.stack ? error.stack : String(error)))
})
process.on('unhandledRejection', (reason) => {
  bootLog('unhandledRejection: ' + (reason && reason.stack ? reason.stack : String(reason)))
})

bootLog('module start')

const API_BASE = 'https://token.m8bj.cn'
const POLL_SECONDS = 30
const CACHE_TTL_MS = 30 * 1000

// ---------- 日志 ----------
// 挂件是后台常驻程序，出错时没有终端可看，写文件便于排查。

function logFile() {
  try {
    return path.join(app.getPath('userData'), 'widget.log')
  } catch {
    return null
  }
}

function writeLog(level, message, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${extra ? ' ' + safeJson(extra) : ''}\n`
  if (level === 'error') console.error(message, extra || '')
  else console.log(message, extra || '')
  try {
    const file = logFile()
    if (!file) return
    // 超过 512KB 时截断，避免无限增长
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) {
      fs.writeFileSync(file, '')
    }
    fs.appendFileSync(file, line, 'utf8')
  } catch { /* 日志失败不影响主流程 */ }
}

function safeJson(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

process.on('uncaughtException', (error) => {
  writeLog('error', 'uncaughtException: ' + (error && error.stack ? error.stack : String(error)))
})
process.on('unhandledRejection', (reason) => {
  writeLog('error', 'unhandledRejection: ' + (reason && reason.stack ? reason.stack : String(reason)))
})

// ---------- 配置持久化 ----------

function configPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

let config = { apiKey: '', mode: 'pill', position: null, alwaysOnTop: true }

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      config = {
        apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
        mode: ['pill', 'circle', 'bar'].includes(parsed.mode) ? parsed.mode : 'pill',
        position: parsed.position && Number.isFinite(parsed.position.x) && Number.isFinite(parsed.position.y)
          ? { x: parsed.position.x, y: parsed.position.y }
          : null,
        alwaysOnTop: parsed.alwaysOnTop !== false
      }
    }
  } catch { /* 首次运行没有配置文件，用默认值 */ }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 })
  } catch (error) {
    console.error('[token-plan] 保存配置失败:', error.message)
  }
}

// ---------- 窗口尺寸（按显示模式） ----------

const SIZES = {
  // 单行胶囊：宽度由内容自适应（见 widget:resize-pill），这里给默认值与边界。
  // 高度 36 是 Windows 无边框窗口的最小高度；写更小会被系统强制放大，
  // 导致锚点计算与实际尺寸不符、切形态时位置逐次漂移（实测每轮 4px）。
  pill: { width: 92, height: 36, minWidth: 76, maxWidth: 190 },
  circle: { width: 60, height: 60 },    // 圆环（≥36，安全）
  bar: { width: 300, height: 108 },     // 迷你条：图标 + 百分比 + 细进度条
  expanded: { width: 380, height: 480 } // 展开详情（含标签页，模型列表可滚动）
}

let win = null
let tray = null
let expanded = false

function sizeFor(mode) {
  const entry = SIZES[mode] || SIZES.pill
  // 只返回宽高，避免 minWidth/maxWidth 等元数据混进 setBounds
  return { width: entry.width, height: entry.height }
}

// 记住胶囊的实际自适应宽度，切模式回来时保持，不让窗口跳一下
let pillWidth = SIZES.pill.width

function sizeForCurrent() {
  if (config.mode === 'pill') return { width: pillWidth, height: SIZES.pill.height }
  return sizeFor(config.mode)
}

function createWindow() {
  const size = sizeForCurrent()
  const area = screen.getPrimaryDisplay().workArea

  // 默认放在主屏右下角（避开任务栏）；有保存位置则沿用
  let x = area.x + area.width - size.width - 28
  let y = area.y + area.height - size.height - 28
  if (config.position) {
    const { x: px, y: py } = clampToScreens(config.position.x, config.position.y, size)
    x = px
    y = py
  } else {
    // 首次启动：把默认落点记下来，避免下次又按旧值计算
    config.position = { x, y }
    saveConfig()
  }

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 关键：让页面发出的请求不带 Origin，服务端要求无 Origin 才放行
      webSecurity: true
    }
  })

  if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  win.once('ready-to-show', () => {
    // 先测出窗口外框与内容区的差值，后续所有尺寸计算都以它为准，
    // 否则无边框窗口在部分 DPI 下会累积几像素的锚点误差。
    measureFrameDelta()
    win.showInactive()
  })

  // 拖动结束后保存位置
  win.on('moved', () => {
    if (!win || expanded) return
    const [wx, wy] = win.getPosition()
    config.position = { x: wx, y: wy }
    saveConfig()
  })

  win.on('closed', () => { win = null })

  // 关闭窗口时若并非主动退出，则隐藏而不是销毁，保证托盘常驻
  win.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })
}

function clampToScreens(x, y, size) {
  const displays = screen.getAllDisplays()
  // 找最接近的显示器
  let best = displays[0]
  let bestDist = Infinity
  for (const d of displays) {
    const a = d.workArea
    const cx = a.x + a.width / 2
    const cy = a.y + a.height / 2
    const dist = Math.hypot(cx - (x + size.width / 2), cy - (y + size.height / 2))
    if (dist < bestDist) { bestDist = dist; best = d }
  }
  const a = best.workArea
  return {
    x: Math.max(a.x, Math.min(x, a.x + a.width - size.width)),
    y: Math.max(a.y, Math.min(y, a.y + a.height - size.height))
  }
}

// ---------- 窗口尺寸与展开切换 ----------

// 统一的位置锚定策略。之前 applyMode 用中心对齐、resize-pill 用右边缘固定，
// 两套算法交替生效导致切形态时位置乱跑。现在统一为"锚定边缘"：
// 卡片在屏幕右半则右边缘不动，在下半则下边缘不动，看起来是从同一个角伸缩。
//
// 注意：setBounds 用的是窗口外框尺寸，无边框窗口在部分 DPI 下可能比 setContentSize
// 设定的内容尺寸多出几像素。因此这里用「已知的当前 bounds」做减法，
// 而不是假设 size 就是实际外框，否则每轮切换会累积几像素误差往上跑。
function anchorPosition(bounds, size) {
  const area = screen.getDisplayMatching(bounds).workArea
  const rightHalf = bounds.x + bounds.width / 2 > area.x + area.width / 2
  const bottomHalf = bounds.y + bounds.height / 2 > area.y + area.height / 2

  const x = rightHalf ? bounds.x + bounds.width - size.width : bounds.x
  const y = bottomHalf ? bounds.y + bounds.height - size.height : bounds.y
  return clampToScreens(Math.round(x), Math.round(y), size)
}

// 把目标内容尺寸换算成实际窗口外框尺寸，消除无边框窗口的边框差，
// 保证锚点计算与 setBounds 用的是同一套坐标系。
let frameDelta = { w: 0, h: 0 }

function frameSizeFor(size) {
  return { width: size.width + frameDelta.w, height: size.height + frameDelta.h }
}

function measureFrameDelta() {
  if (!win) return
  const b = win.getBounds()
  const [cw, ch] = win.getContentSize()
  frameDelta = { w: Math.max(0, b.width - cw), h: Math.max(0, b.height - ch) }
}

function applyMode(mode) {
  if (!win) return
  const nextMode = ['pill', 'circle', 'bar'].includes(mode) ? mode : 'pill'
  config.mode = nextMode
  saveConfig()

  // 切到 pill 时用上次记住的自适应宽度，避免先撑大再收缩
  const size = nextMode === 'pill'
    ? { width: pillWidth, height: SIZES.pill.height }
    : sizeFor(nextMode)

  expanded = false
  applyBounds(size)
  win.webContents.send('widget:mode-changed', { mode: nextMode, expanded: false })
}

// 统一改尺寸入口：先按内容尺寸设好，再用实际外框计算锚点位置，
// 避免"以为外框等于内容尺寸"导致的逐次累积漂移。
function applyBounds(size) {
  if (!win) return
  const bounds = win.getBounds()

  // 用 setBounds 一次性设尺寸+位置；外框与内容尺寸的差值通过实测修正
  const frame = frameSizeFor(size)
  const target = anchorPosition(bounds, frame)
  win.setResizable(true)
  win.setBounds({ x: target.x, y: target.y, width: frame.width, height: frame.height })
  win.setResizable(false)

  // 自我校正：系统可能强制放大（Windows 无边框窗口最小高 36px）。
  // 若实际尺寸与请求不一致，用"切换前的 bounds"重新锚定，保证边缘不漂移。
  const after = win.getBounds()
  const [cw, ch] = win.getContentSize()
  frameDelta = { w: Math.max(0, after.width - cw), h: Math.max(0, after.height - ch) }

  if (after.width !== frame.width || after.height !== frame.height) {
    const fixed = anchorPosition(bounds, { width: after.width, height: after.height })
    win.setBounds({ x: fixed.x, y: fixed.y, width: after.width, height: after.height })
  }
}

function setExpanded(nextExpanded) {
  if (!win) return
  expanded = nextExpanded

  if (expanded) {
    // 展开：从当前锚点朝屏幕内侧生长（靠近右下角则向左上展开）
    applyBounds(SIZES.expanded)
    if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver')
    // 窗口平时用 showInactive 显示（不抢焦点），展开时要主动聚焦，
    // 否则设置面板里的输入框拿不到键盘输入。
    win.show()
    win.focus()
    win.webContents.focus()
  } else {
    // 收起：同样按锚点回到小尺寸，避免每次收起都往右下角漂
    applyBounds(sizeForCurrent())
    const b = win.getBounds()
    config.position = { x: b.x, y: b.y }
    saveConfig()
  }

  win.webContents.send('widget:mode-changed', { mode: config.mode, expanded })
}

// ---------- 用量查询 ----------

let cache = { at: 0, data: null, error: null }

function normalizeError(status, body) {
  if (status === 401) return 'Key 无效、已停用或已轮换，请重新输入。'
  if (status === 403) return '查询服务拒绝访问（来源校验失败）。'
  if (status === 409) return 'Key 脱敏值冲突，请联系管理员配置 HMAC 摘要。'
  if (status === 429) return '请求过于频繁，请稍后重试。'
  if (status === 503) return '查询服务暂时没有可用数据，请稍后重试。'
  if (body && typeof body.error === 'string') return body.error
  return '查询服务返回异常，请稍后重试。'
}

// ---------- 模型用量 ----------
// GET /api/me/model-usage?range=today|7d|30d
// 服务端汇总中的请求会返回 202，需要等几秒重试（与官方插件行为一致）。

const modelCache = new Map() // key: range -> { at, data }
const MODEL_CACHE_TTL_MS = 30 * 1000
const RANGES = ['today', '7d', '30d']

async function fetchModelUsage(range, force) {
  if (!RANGES.includes(range)) return { ok: false, error: '无效查询范围。' }
  if (!config.apiKey) return { ok: false, error: '尚未设置 API Key。', needKey: true }

  const cached = modelCache.get(range)
  if (!force && cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
    return { ok: true, data: cached.data, cached: true }
  }

  // 汇总中（202）时重试，最多约 20 秒
  const deadline = Date.now() + 20000
  let attempt = 0

  while (Date.now() < deadline) {
    attempt++
    try {
      const response = await fetch(`${API_BASE}/api/me/model-usage?range=${encodeURIComponent(range)}`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${config.apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15000)
      })

      if (response.status === 202) {
        // 仍在汇总，稍后重试
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }

      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = null }

      if (response.ok && body) {
        const models = Array.isArray(body.models)
          ? body.models
              .filter((row) => row && typeof row.model === 'string' && typeof row.credits === 'string')
              .slice(0, 200)
              .map((row) => ({ model: row.model.slice(0, 200), credits: row.credits.slice(0, 40) }))
          : []

        const data = {
          range: RANGES.includes(body.range) ? body.range : range,
          unit: body.unit === '积分' ? '积分' : '积分',
          approximate: body.approximate === true,
          startsAt: safeDate(body.startsAt),
          endsAt: safeDate(body.endsAt),
          updatedAt: safeDate(body.updatedAt),
          models
        }
        modelCache.set(range, { at: Date.now(), data })
        return { ok: true, data, cached: false, attempts: attempt }
      }

      const message = normalizeError(response.status, body)
      // 429 时按服务端要求等待，但不在这里长时间阻塞
      if (response.status === 429) {
        const wait = Math.min(6000, Math.max(2000, Number(response.headers.get('retry-after')) * 1000 || 3000))
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      return { ok: false, error: message, status: response.status }
    } catch (error) {
      const isTimeout = error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      if (isTimeout && Date.now() < deadline) continue
      return { ok: false, error: isTimeout ? '查询模型用量超时。' : '无法连接查询服务，请检查网络或代理。' }
    }
  }

  return { ok: false, error: '模型用量仍在汇总，请稍后重试。', pending: true }
}

async function fetchUsage(force) {
  const now = Date.now()
  if (!force && cache.data && now - cache.at < CACHE_TTL_MS) {
    return { ok: true, data: cache.data, cached: true }
  }
  if (!config.apiKey) {
    return { ok: false, error: '尚未设置 API Key。', needKey: true }
  }
  if (!/^sk-[A-Za-z0-9_-]{12,500}$/.test(config.apiKey)) {
    return { ok: false, error: 'API Key 格式不正确（应以 sk- 开头）。', needKey: true }
  }

  try {
    // 直接用 net 层请求，不带 Origin 头，符合服务端来源校验要求
    const response = await fetch(`${API_BASE}/api/me/usage`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.apiKey}`
      },
      redirect: 'error',
      signal: AbortSignal.timeout(12000)
    })

    const text = await response.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }

    if (response.ok && body) {
      const quota = safeDecimal(body.usage && body.usage.exclusiveQuota)
      const used = safeDecimal(body.usage && body.usage.exclusiveUsed)
      // 额度状态一律自己算，不信服务端的 quotaExhausted 字段。
      // 实测该字段会与实际数据矛盾（例如 used=516.90 / quota=10000 却报 exhausted=true），
      // 官方 DSH 插件同样是自己按 total/used 判断的。
      const computed = computeQuota(quota, used)

      const data = {
        name: safeString(body.name),
        maskedKey: safeString(body.maskedKey),
        unit: body.unit === 'Token' ? 'Token' : '积分',
        status: body.status === '已停用' ? '已停用' : '正常',
        // 保留原始字段仅作诊断，界面不再直接使用
        serverQuotaExhausted: body.quotaExhausted === true,
        unallocated: computed.unallocated,
        exhausted: computed.exhausted,
        usedPercent: computed.percent,          // 自己算的百分比，覆盖服务端值
        serverUsedPercent: safePercent(body.exclusiveUsedPercent),
        exclusiveQuota: quota,
        exclusiveUsed: used,
        exclusiveRemain: computed.remain,
        updatedAt: safeDate(body.updatedAt),
        startsAt: safeDate(body.startsAt),
        expiresAt: safeDate(body.expiresAt),
        stale: body.stale === true,
        ranking: body.ranking && Number.isSafeInteger(body.ranking.rank) && Number.isSafeInteger(body.ranking.total)
          ? { rank: body.ranking.rank, total: body.ranking.total }
          : null
      }
      cache = { at: now, data, error: null }
      return { ok: true, data, cached: false }
    }

    const message = normalizeError(response.status, body)
    return { ok: false, error: message, status: response.status, unauthorized: response.status === 401 }
  } catch (error) {
    const isTimeout = error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return { ok: false, error: isTimeout ? '连接查询服务超时。' : '无法连接查询服务，请检查网络或代理。' }
  }
}

function safeString(value) {
  return typeof value === 'string' ? value.slice(0, 200) : ''
}

// ---------- 额度计算 ----------
// 与官方 DSH 插件算法保持一致（BigInt 精确运算，避免十进制字符串转浮点丢精度）。
// 输入是十进制字符串，输出剩余额度字符串、百分比、以及是否耗尽/未分配。

function toScaledInt(value, scale) {
  const [whole, fraction = ''] = String(value).split('.')
  return BigInt(whole + fraction.padEnd(scale, '0'))
}

function computeQuota(quotaStr, usedStr) {
  const empty = { remain: null, percent: null, unallocated: false, exhausted: false, usedNumber: null }
  if (quotaStr == null || usedStr == null) return empty

  try {
    const scale = Math.max((String(quotaStr).split('.')[1] || '').length,
                           (String(usedStr).split('.')[1] || '').length)
    const total = toScaledInt(quotaStr, scale)
    const used = toScaledInt(usedStr, scale)

    const remaining = total > used ? total - used : 0n
    const raw = remaining.toString().padStart(scale + 1, '0')
    const remain = scale ? raw.slice(0, -scale) + '.' + raw.slice(-scale) : raw

    // 百分比：四舍五入到两位小数，用整数运算（hundredths = used*10000/total）
    const hundredths = total > 0n ? (used * 10000n + total / 2n) / total : null

    return {
      remain,
      percent: hundredths == null ? null : `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`,
      // 未分配额度（总额为 0）与"已耗尽"要区分开，前者不应显示成耗尽
      unallocated: total === 0n,
      exhausted: total === 0n || used >= total,
      usedNumber: hundredths == null ? null : Number(hundredths) / 100
    }
  } catch {
    return empty
  }
}

function safeDecimal(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && value.length <= 100) return value
  return null
}

function safePercent(value) {
  if (typeof value !== 'string') return null
  if (value === '—') return null
  return /^\d+(?:\.\d{2})%$/.test(value) ? value : null
}

function safeDate(value) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value
  return null
}

// ---------- 托盘 ----------

function trayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png')
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath)
  // 兜底：用内联的 16x16 圆点，避免托盘空白
  const size = 16
  const buffer = Buffer.alloc(size * size * 4)
  const cx = (size - 1) / 2
  const cy = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const d = Math.hypot(x - cx, y - cy)
      const inside = d <= 6.5
      // BGRA
      buffer[i] = 0x53 // B
      buffer[i + 1] = 0x66 // G
      buffer[i + 2] = 0x35 // R
      buffer[i + 3] = inside ? (d > 5.5 ? 180 : 255) : 0
    }
  }
  return nativeImage.createFromBuffer(buffer, { width: size, height: size })
}

function buildTrayMenu() {
  const items = [
    {
      label: win && win.isVisible() ? '隐藏挂件' : '显示挂件',
      click: () => {
        if (!win) { createWindow(); return }
        if (win.isVisible()) win.hide()
        else { win.showInactive() }
      }
    },
    { type: 'separator' },
    {
      label: '显示模式',
      submenu: [
        { label: '胶囊', type: 'radio', checked: config.mode === 'pill', click: () => applyMode('pill') },
        { label: '圆环', type: 'radio', checked: config.mode === 'circle', click: () => applyMode('circle') },
        { label: '迷你条', type: 'radio', checked: config.mode === 'bar', click: () => applyMode('bar') }
      ]
    },
    {
      label: '总在最前',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (menuItem) => {
        config.alwaysOnTop = menuItem.checked
        saveConfig()
        if (win) win.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver')
        rebuildTray()
      }
    },
    { type: 'separator' },
    { label: '重新查询', click: () => { if (win) win.webContents.send('widget:refresh-request') } },
    {
      label: '设置 API Key…',
      click: () => {
        if (!win) createWindow()
        win.showInactive()
        win.webContents.send('widget:open-settings')
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit() } }
  ]
  return Menu.buildFromTemplate(items)
}

function rebuildTray() {
  if (!tray) return
  tray.setContextMenu(buildTrayMenu())
}

function createTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip('Token Plan 用量')
  rebuildTray()
  tray.on('click', () => {
    if (!win) { createWindow(); return }
    if (win.isVisible()) win.hide()
    else win.showInactive()
  })
}

// ---------- IPC ----------

ipcMain.handle('widget:init', async () => {
  return {
    mode: config.mode,
    expanded,
    hasKey: Boolean(config.apiKey),
    maskedKey: config.apiKey ? `••••${config.apiKey.slice(-4)}` : '',
    alwaysOnTop: config.alwaysOnTop
  }
})

ipcMain.handle('widget:get-usage', async (_event, force) => {
  return await fetchUsage(force === true)
})

ipcMain.handle('widget:get-model-usage', async (_event, range, force) => {
  return await fetchModelUsage(typeof range === 'string' ? range : 'today', force === true)
})

ipcMain.handle('widget:set-key', async (_event, key) => {
  const trimmed = typeof key === 'string' ? key.trim() : ''
  if (!trimmed) return { ok: false, error: '请输入 API Key。' }
  if (!/^sk-[A-Za-z0-9_-]{12,500}$/.test(trimmed)) {
    return { ok: false, error: 'API Key 格式不正确（应以 sk- 开头，至少 15 位）。' }
  }
  config.apiKey = trimmed
  saveConfig()
  cache = { at: 0, data: null, error: null }
  modelCache.clear()
  return await fetchUsage(true)
})

ipcMain.handle('widget:clear-key', async () => {
  config.apiKey = ''
  saveConfig()
  cache = { at: 0, data: null, error: null }
  modelCache.clear()
  return { ok: true }
})

ipcMain.handle('widget:set-mode', async (_event, mode) => {
  applyMode(mode)
  return { ok: true, mode: config.mode }
})

// 胶囊宽度自适应：渲染层量出内容实际宽度后回传，主进程调整窗口。
// 只允许 pill 模式生效，并夹在合理区间，避免异常值把窗口撑爆。
ipcMain.handle('widget:resize-pill', async (_event, contentWidth) => {
  if (!win || expanded || config.mode !== 'pill') return { ok: false }
  const width = Math.round(Number(contentWidth))
  if (!Number.isFinite(width)) return { ok: false }
  const clamped = Math.max(SIZES.pill.minWidth, Math.min(SIZES.pill.maxWidth, width))
  pillWidth = clamped
  const height = SIZES.pill.height

  // 用统一的改尺寸入口，和切形态/展开走同一套锚点算法
  const frame = frameSizeFor({ width: clamped, height })
  const bounds = win.getBounds()
  if (bounds.width === frame.width && bounds.height === frame.height) {
    return { ok: true, width: clamped, changed: false }
  }

  applyBounds({ width: clamped, height })
  return { ok: true, width: clamped, changed: true }
})

ipcMain.handle('widget:set-expanded', async (_event, value) => {
  setExpanded(value === true)
  return { ok: true, expanded }
})

ipcMain.handle('widget:set-always-on-top', async (_event, value) => {
  config.alwaysOnTop = value === true
  saveConfig()
  if (win) win.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver')
  rebuildTray()
  return { ok: true, alwaysOnTop: config.alwaysOnTop }
})

ipcMain.handle('widget:hide', async () => {
  if (win) win.hide()
  return { ok: true }
})

ipcMain.handle('widget:quit', async () => {
  app.isQuitting = true
  app.quit()
  return { ok: true }
})

ipcMain.handle('widget:open-docs', async () => {
  await shell.openExternal(`${API_BASE}/docs`)
  return { ok: true }
})

// ---------- 手动拖动（替代 -webkit-app-region: drag） ----------
// app-region 拖动会吞掉鼠标事件导致无法点击，这里用指针位移驱动窗口移动。
// 传入屏幕坐标系下的起点与当前点，主进程算出窗口新位置。

let dragOrigin = null

ipcMain.handle('widget:drag-start', async (_event, point) => {
  if (!win) return { ok: false }
  if (!point || !Number.isFinite(point.screenX) || !Number.isFinite(point.screenY)) return { ok: false }
  const [wx, wy] = win.getPosition()
  dragOrigin = { pointerX: point.screenX, pointerY: point.screenY, winX: wx, winY: wy }
  return { ok: true }
})

ipcMain.handle('widget:drag-move', async (_event, point) => {
  if (!win || !dragOrigin) return { ok: false }
  if (!point || !Number.isFinite(point.screenX) || !Number.isFinite(point.screenY)) return { ok: false }
  const dx = Math.round(point.screenX - dragOrigin.pointerX)
  const dy = Math.round(point.screenY - dragOrigin.pointerY)
  const size = expanded ? SIZES.expanded : sizeForCurrent()
  const target = clampToScreens(dragOrigin.winX + dx, dragOrigin.winY + dy, size)
  win.setPosition(target.x, target.y)
  return { ok: true }
})

ipcMain.handle('widget:drag-end', async () => {
  if (!win || !dragOrigin) { dragOrigin = null; return { ok: false } }
  dragOrigin = null
  const [wx, wy] = win.getPosition()
  config.position = { x: wx, y: wy }
  saveConfig()
  return { ok: true, position: { x: wx, y: wy } }
});

// ---------- 生命周期 ----------

// 固定 userData 目录名。打包后 productName 变化会让默认路径跟着变，
// 导致用户已保存的 Key 和窗口位置"丢失"。这里写死，保证升级/换打包方式后数据不变。
// 注意前置分号：上一行是 `})`，若不加分号会被解析成 `handle(...)(...)` 调用。
;(() => {
  const appData = app.getPath('appData')
  const stable = path.join(appData, 'TokenPlanWidget')
  const legacy = app.getPath('userData')

  // 旧版本（未打包 / 早期 productName）数据迁移：仅在稳定目录还没有配置时搬一次
  try {
    if (legacy !== stable && fs.existsSync(legacy)) {
      const legacyConfig = path.join(legacy, 'config.json')
      const stableConfig = path.join(stable, 'config.json')
      if (fs.existsSync(legacyConfig) && !fs.existsSync(stableConfig)) {
        fs.mkdirSync(stable, { recursive: true })
        fs.copyFileSync(legacyConfig, stableConfig)
      }
    }
  } catch { /* 迁移失败不影响启动 */ }

  app.setPath('userData', stable)
})()

// 禁用 GPU 加速。
// 打包版（asar + 便携 exe）下，透明无边框窗口配合硬件加速会静默崩溃：
// 进程起来后立刻退出，没有任何 stderr、也不写日志，用户只看到"双击没反应"。
// 加 --disable-gpu 参数可正常启动，因此在这里硬编码，避免依赖启动参数。
// 这个挂件只有少量 DOM 元素，软件渲染完全够用，且能保证跨机器一致。
app.disableHardwareAcceleration()
bootLog('hardware acceleration disabled')

// 关闭 asar 完整性强制校验相关的颜色/字体子像素差异带来的不稳定因素
app.commandLine.appendSwitch('disable-gpu-compositing')

bootLog('lifecycle start')

const gotLock = app.requestSingleInstanceLock()
bootLog('singleInstanceLock=' + gotLock)

if (!gotLock) {
  bootLog('quit: not got lock')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { win.showInactive() }
  })

  app.whenReady().then(() => {
    bootLog('app ready')
    try {
      loadConfig()
      bootLog('config loaded')
      createWindow()
      bootLog('window created')
      createTray()
      bootLog('tray created')
    } catch (error) {
      bootLog('startup error: ' + (error && error.stack ? error.stack : String(error)))
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((error) => {
    bootLog('whenReady rejected: ' + (error && error.stack ? error.stack : String(error)))
  })

  // 挂件常驻托盘，不随窗口关闭退出。
  // 注意：window-all-closed 没有 preventDefault，必须在关闭前拦截（见 win 'close' 事件）。
  app.on('window-all-closed', () => {
    // 若因意外导致窗口全关且非主动退出，重建窗口而不是退出进程
    if (!app.isQuitting) {
      createWindow()
      if (tray) rebuildTray()
    }
  })

  // 渲染进程崩溃时自动恢复，避免挂件凭空消失且无提示
  app.on('render-process-gone', (_event, _webContents, details) => {
    console.error('[token-plan] 渲染进程异常:', details && details.reason)
    if (!app.isQuitting) {
      if (win && !win.isDestroyed()) {
        win.reload()
      } else {
        createWindow()
      }
    }
  })

  app.on('child-process-gone', (_event, details) => {
    console.error('[token-plan] 子进程异常:', details && details.type, details && details.reason)
  })
}

module.exports = { SIZES, POLL_SECONDS }
