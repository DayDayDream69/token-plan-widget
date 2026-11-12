'use strict'

/* ============================================================
   Token Plan 挂件渲染逻辑
   ============================================================ */

const root = document.getElementById('root')

const el = {
  pillPct: document.querySelector('.pill-pct'),
  circlePct: document.querySelector('.circle-pct'),
  ringFill: document.querySelector('.ring-fill'),

  barPct: document.querySelector('.bar-pct'),
  barFill: document.querySelector('.surface-bar .bar-fill'),
  barRemain: document.querySelector('.bar-remain'),
  barUnit: document.querySelector('.bar-unit'),

  headSub: document.getElementById('head-sub'),
  remain: document.getElementById('remain'),
  unit: document.getElementById('unit'),
  heroNote: document.getElementById('hero-note'),
  panelFill: document.getElementById('panel-fill'),
  usedLine: document.getElementById('used-line'),
  quotaLine: document.getElementById('quota-line'),

  status: document.getElementById('status'),
  cycle: document.getElementById('cycle'),
  ranking: document.getElementById('ranking'),
  updated: document.getElementById('updated'),

  stale: document.getElementById('stale'),
  error: document.getElementById('error'),

  settings: document.getElementById('settings'),
  keyInput: document.getElementById('key-input'),
  keyError: document.getElementById('key-error'),
  btnSave: document.getElementById('btn-save'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnCollapse: document.getElementById('btn-collapse'),
  btnKey: document.getElementById('btn-key'),
  btnReveal: document.getElementById('btn-reveal'),
  btnCancel: document.getElementById('btn-cancel'),

  // 模型用量
  modelRange: document.getElementById('model-range'),
  modelStatus: document.getElementById('model-status'),
  modelsTable: document.getElementById('models-table'),
  modelsBody: document.getElementById('models-body'),
  modelFoot: document.getElementById('model-foot'),
  modelError: document.getElementById('model-error'),
  btnModelRefresh: document.getElementById('btn-model-refresh')
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 26 // ≈ 163.36

let state = {
  mode: 'pill',
  expanded: false,
  hasKey: false,
  alwaysOnTop: true,
  usage: null,
  lastError: null,
  polling: null,
  busy: false,
  tab: 'overview',
  modelCache: new Map() // range -> data
}

// ---------- 工具 ----------

function fmtNumber(value, compact) {
  if (value == null) return '—'
  const str = String(value)
  let [int, dec] = str.split('.')
  // 千分位
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (!dec) return grouped
  // 小空间（胶囊/迷你条）只留 2 位；详情面板保留完整精度，
  // 服务端给的额度精度（如 9483.0954）应原样呈现，不能静默截断。
  if (compact) dec = dec.slice(0, 2)
  return `${grouped}.${dec}`
}

function parsePercent(percentStr) {
  if (!percentStr) return null
  const match = /^(\d+(?:\.\d+)?)%$/.exec(percentStr)
  if (!match) return null
  return Number(match[1])
}

function relativeTime(iso) {
  if (!iso) return '—'
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return '—'
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

function fmtDate(iso) {
  if (!iso) return null
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return null
  const d = new Date(ts)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso)
  const b = Date.parse(toIso)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.ceil((b - a) / 86400000)
}

function setState(next) {
  root.setAttribute('data-state', next)
}

// ---------- 渲染 ----------

// 胶囊宽度自适应：量出内容自然宽度后让主进程把窗口收窄/放宽。
// 只在 pill 模式、未展开时生效；用 rAF 合并多次调用，避免频繁改窗口尺寸。
let resizeScheduled = false

function schedulePillResize() {
  if (resizeScheduled) return
  resizeScheduled = true
  requestAnimationFrame(() => {
    resizeScheduled = false
    if (state.mode !== 'pill' || state.expanded) return
    const surface = document.querySelector('.surface-pill')
    if (!surface) return

    // 让内容按自然宽度排布后测量：图标 + 文本 + 状态点 + 内边距 + 左右 root padding
    const cs = getComputedStyle(surface)
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
    const gap = parseFloat(cs.gap) || 0
    const border = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)

    const bolt = surface.querySelector('.bolt')
    const text = surface.querySelector('.pill-text')
    const dot = surface.querySelector('.dot')
    const textW = text ? Math.ceil(text.scrollWidth) : 0
    const parts = [bolt, text, dot].filter(Boolean).length
    const rootPad = 4 * 2 // #root padding 左右各 4px

    const contentWidth = Math.ceil(padX + border + textW
      + (bolt ? bolt.offsetWidth : 0)
      + (dot ? dot.offsetWidth : 0)
      + gap * Math.max(0, parts - 1)
      + rootPad)

    window.widget.resizePill(contentWidth)
  })
}

function renderUsage() {
  const u = state.usage

  if (!u) {
    const pctText = state.hasKey ? '—' : '设置 Key'
    el.pillPct.textContent = pctText
    el.circlePct.textContent = state.hasKey ? '—' : '—'
    el.ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE)
    el.barPct.textContent = '—'
    el.barFill.style.width = '0%'
    el.barRemain.textContent = state.hasKey ? '等待查询' : '未设置 Key'
    el.barUnit.textContent = ''
    el.headSub.textContent = state.hasKey ? '等待数据' : '未设置 API Key'
    setState(state.lastError ? 'error' : 'loading')
    schedulePillResize()
    return
  }

  // usedPercent 现在由主进程用 BigInt 算出，不再采用服务端可能自相矛盾的值
  const usedNum = parsePercent(u.usedPercent)
  const pctLabel = u.usedPercent || '—'

  el.pillPct.textContent = pctLabel
  el.circlePct.textContent = usedNum == null ? '—' : `${Math.round(usedNum)}%`
  el.barPct.textContent = pctLabel
  el.barRemain.textContent = u.exclusiveRemain != null ? `剩 ${fmtNumber(u.exclusiveRemain, true)}` : '—'
  el.barUnit.textContent = u.unit || ''

  const pctForBar = usedNum == null ? 0 : Math.min(100, usedNum)
  el.barFill.style.width = `${pctForBar}%`
  el.panelFill.style.width = `${pctForBar}%`

  if (usedNum == null) {
    el.ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE)
  } else {
    const pct = Math.min(100, usedNum) / 100
    el.ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - pct))
  }

  // 面板
  el.headSub.textContent = `${u.name || 'Token Plan'} · ${u.maskedKey || ''}`.trim()
  el.remain.textContent = u.exclusiveRemain != null ? fmtNumber(u.exclusiveRemain) : '—'
  el.unit.textContent = u.unit || ''

  el.usedLine.textContent = u.exclusiveUsed != null ? `已用 ${fmtNumber(u.exclusiveUsed)}` : '已用 —'
  el.quotaLine.textContent = u.exclusiveQuota != null ? `总额 ${fmtNumber(u.exclusiveQuota)}` : '总额 —'

  // 额度状态：按 used/quota 自行判定，与官方插件口径一致
  if (u.status === '已停用') {
    el.status.textContent = '已停用'
    el.status.className = 'bad'
    el.heroNote.textContent = '此 Key 已被停用。'
  } else if (u.unallocated) {
    el.status.textContent = '未分配额度'
    el.status.className = 'warn'
    el.heroNote.textContent = '当前 Key 未分配独占额度。'
  } else if (u.exhausted) {
    el.status.textContent = '额度已用尽'
    el.status.className = 'bad'
    el.heroNote.textContent = '当前额度已用完。'
  } else if (usedNum != null && usedNum >= 90) {
    el.status.textContent = '额度即将用尽'
    el.status.className = 'warn'
    el.heroNote.textContent = `已使用 ${pctLabel}`
  } else {
    el.status.textContent = '额度充足'
    el.status.className = 'good'
    const days = u.expiresAt ? daysBetween(new Date().toISOString(), u.expiresAt) : null
    el.heroNote.textContent = days != null
      ? (days >= 0 ? `套餐剩余 ${days} 天` : '套餐已过期')
      : ''
  }

  // 套餐周期
  const start = fmtDate(u.startsAt)
  const end = fmtDate(u.expiresAt)
  el.cycle.textContent = start && end ? `${start} → ${end}` : '—'

  // 排名
  if (u.ranking && Number.isSafeInteger(u.ranking.rank) && Number.isSafeInteger(u.ranking.total)) {
    el.ranking.textContent = `第 ${u.ranking.rank} / ${u.ranking.total} 名`
  } else {
    el.ranking.textContent = '—'
  }

  el.updated.textContent = relativeTime(u.updatedAt)

  // 状态色：与上面面板状态判定保持同一口径
  if (u.status === '已停用' || u.exhausted) setState('danger')
  else if (u.unallocated) setState('warn')
  else if (usedNum != null && usedNum >= 90) setState('danger')
  else if (usedNum != null && usedNum >= 70) setState('warn')
  else setState('ok')

  el.stale.hidden = !u.stale
  el.error.hidden = true
  schedulePillResize()
}

function renderError(message) {
  el.error.textContent = message
  el.error.hidden = false
  setState('error')
}

// ---------- 查询 ----------

async function refresh(force) {
  if (state.busy) return
  state.busy = true
  el.btnRefresh.classList.add('spinning')
  try {
    const result = await window.widget.getUsage(force === true)
    if (result && result.ok) {
      state.usage = result.data
      state.lastError = null
      el.error.hidden = true
      renderUsage()
    } else {
      state.lastError = result && result.error ? result.error : '查询失败。'
      if (result && result.needKey) {
        state.hasKey = false
        state.usage = null
        renderUsage()
        el.headSub.textContent = '未设置 API Key'
      } else if (state.usage) {
        // 有上次成功的数据：保持数据与状态灯不变，只标记"数据非最新"。
        // 之前这里会调 renderError 把状态灯打成红色闪烁，
        // 导致网络偶发抖动时"明明额度充足却闪红点"。
        state.usage.stale = true
        renderUsage()
        el.error.textContent = state.lastError
        el.error.hidden = false
      } else {
        renderError(state.lastError)
      }
    }
  } catch (error) {
    state.lastError = '查询出错：' + (error && error.message ? error.message : '未知错误')
    if (state.usage) {
      state.usage.stale = true
      renderUsage()
      el.error.textContent = state.lastError
      el.error.hidden = false
    } else {
      renderError(state.lastError)
    }
  } finally {
    state.busy = false
    el.btnRefresh.classList.remove('spinning')
  }
}

function startPolling() {
  stopPolling()
  state.polling = setInterval(() => {
    if (document.hidden) return
    refresh(false)
  }, 30000)
}

function stopPolling() {
  if (state.polling) {
    clearInterval(state.polling)
    state.polling = null
  }
}

// ---------- 交互 ----------

function setExpanded(next) {
  state.expanded = next
  root.setAttribute('data-expanded', next ? 'true' : 'false')
  window.widget.setExpanded(next)
  if (next) {
    renderUsage()
    if (!state.hasKey) openSettings()
    else refresh(false)
  }
}

function openSettings() {
  el.settings.hidden = false
  el.keyError.hidden = true
  el.keyInput.value = ''
  el.keyInput.focus()
}

function closeSettings() {
  el.settings.hidden = true
  el.keyError.hidden = true
}

// ---------- 拖动与点击的统一处理 ----------
// 不用 -webkit-app-region: drag（会吞掉点击事件），改用指针事件手动拖动。
// 位移超过阈值算拖动，否则算点击。

const DRAG_THRESHOLD = 4 // px，小于此位移视为点击

function attachDrag(node, onClick) {
  let session = null
  let moved = false

  node.addEventListener('pointerdown', async (event) => {
    if (event.button !== 0) return
    // 允许在按钮/输入框上正常操作，不启动拖动
    if (event.target.closest('button, input, a, select, .settings')) return

    moved = false
    session = { pointerId: event.pointerId, startX: event.screenX, startY: event.screenY }
    try { node.setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
    await window.widget.dragStart({ screenX: event.screenX, screenY: event.screenY })
  })

  node.addEventListener('pointermove', async (event) => {
    if (!session || event.pointerId !== session.pointerId) return
    const dx = event.screenX - session.startX
    const dy = event.screenY - session.startY
    if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return

    if (!moved) {
      moved = true
      node.classList.add('dragging')
    }
    await window.widget.dragMove({ screenX: event.screenX, screenY: event.screenY })
  })

  const finish = async (event) => {
    if (!session) return
    if (event && event.pointerId !== undefined && event.pointerId !== session.pointerId) return
    const wasDrag = moved
    session = null
    moved = false
    node.classList.remove('dragging')
    try { node.releasePointerCapture(event.pointerId) } catch { /* 忽略 */ }
    await window.widget.dragEnd()
    if (!wasDrag && typeof onClick === 'function') onClick()
  }

  node.addEventListener('pointerup', finish)
  node.addEventListener('pointercancel', finish)
}

// 三个悬浮形态：拖动移动，单击展开
for (const surface of document.querySelectorAll('.surface')) {
  attachDrag(surface, () => {
    if (state.expanded) return
    setExpanded(true)
  })
}

// 展开面板：拖头部移动窗口
const panelHead = document.querySelector('.panel-head')
if (panelHead) attachDrag(panelHead, null)

el.btnCollapse.addEventListener('click', () => setExpanded(false))
el.btnRefresh.addEventListener('click', () => {
  if (state.tab === 'models') loadModels(true)
  else refresh(true)
})

// ---------- 模型用量 ----------

function fmtCredits(value) {
  if (value == null) return '—'
  const str = String(value)
  const [int, dec] = str.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return dec ? `${grouped}.${dec}` : grouped
}

function setTab(tab) {
  state.tab = tab === 'models' ? 'models' : 'overview'
  for (const btn of document.querySelectorAll('.tab')) {
    btn.setAttribute('aria-selected', btn.getAttribute('data-tab') === state.tab ? 'true' : 'false')
  }
  for (const pane of document.querySelectorAll('.tab-pane')) {
    pane.hidden = pane.getAttribute('data-pane') !== state.tab
  }
  if (state.tab === 'models') loadModels(false)
}

async function loadModels(force) {
  const range = el.modelRange.value || 'today'
  el.btnModelRefresh.classList.add('spinning')
  el.modelError.hidden = true

  // 有缓存时先展示，避免闪一下"加载中"
  const cachedKey = `${range}`
  if (!force && state.modelCache.has(cachedKey)) {
    renderModels(state.modelCache.get(cachedKey))
  } else {
    el.modelsTable.hidden = true
    el.modelFoot.hidden = true
    el.modelStatus.hidden = false
    el.modelStatus.textContent = '加载中…'
  }

  try {
    const result = await window.widget.getModelUsage(range, force === true)
    if (result && result.ok) {
      state.modelCache.set(cachedKey, result.data)
      renderModels(result.data)
    } else {
      el.modelsTable.hidden = true
      el.modelFoot.hidden = true
      el.modelStatus.hidden = false
      el.modelStatus.textContent = '—'
      el.modelError.textContent = result && result.error ? result.error : '查询模型用量失败。'
      el.modelError.hidden = false
    }
  } catch (error) {
    el.modelsTable.hidden = true
    el.modelFoot.hidden = true
    el.modelStatus.hidden = false
    el.modelStatus.textContent = '—'
    el.modelError.textContent = '查询出错：' + (error && error.message ? error.message : '未知错误')
    el.modelError.hidden = false
  } finally {
    el.btnModelRefresh.classList.remove('spinning')
  }
}

function renderModels(data) {
  const models = (data && Array.isArray(data.models)) ? data.models : []

  el.modelStatus.hidden = true
  el.modelError.hidden = true

  if (!models.length) {
    el.modelsTable.hidden = true
    el.modelFoot.hidden = true
    el.modelStatus.hidden = false
    el.modelStatus.textContent = '该时间段内没有用量记录。'
    return
  }

  el.modelsBody.textContent = ''
  for (const row of models) {
    const tr = document.createElement('tr')
    const tdName = document.createElement('td')
    tdName.textContent = row.model
    const tdCredits = document.createElement('td')
    tdCredits.textContent = fmtCredits(row.credits)
    tr.append(tdName, tdCredits)
    el.modelsBody.appendChild(tr)
  }
  el.modelsTable.hidden = false

  // 底部：更新时间 + 口径说明
  const parts = []
  if (data.updatedAt) {
    const ts = Date.parse(data.updatedAt)
    if (Number.isFinite(ts)) {
      const d = new Date(ts)
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      parts.push(`${hh}:${mm} 更新`)
    }
  }
  if (data.approximate) parts.push('估算数据，可能延迟')
  el.modelFoot.textContent = parts.join(' · ')
  el.modelFoot.hidden = parts.length === 0
}

// 标签页点击
for (const btn of document.querySelectorAll('.tab')) {
  btn.addEventListener('click', () => setTab(btn.getAttribute('data-tab')))
}
el.modelRange.addEventListener('change', () => loadModels(true))
el.btnModelRefresh.addEventListener('click', () => loadModels(true))


el.btnKey.addEventListener('click', openSettings)
el.btnCancel.addEventListener('click', closeSettings)

el.btnReveal.addEventListener('click', () => {
  const isPwd = el.keyInput.type === 'password'
  el.keyInput.type = isPwd ? 'text' : 'password'
  el.btnReveal.textContent = isPwd ? '隐藏' : '显示'
})

el.btnSave.addEventListener('click', async () => {
  const key = el.keyInput.value.trim()
  if (!key) {
    el.keyError.textContent = '请输入 API Key。'
    el.keyError.hidden = false
    return
  }
  el.btnSave.disabled = true
  el.btnSave.textContent = '查询中…'
  try {
    const result = await window.widget.setKey(key)
    if (result && result.ok) {
      state.usage = result.data
      state.hasKey = true
      state.lastError = null
      el.error.hidden = true
      closeSettings()
      renderUsage()
    } else {
      el.keyError.textContent = result && result.error ? result.error : '保存失败。'
      el.keyError.hidden = false
    }
  } catch (error) {
    el.keyError.textContent = '保存失败：' + (error && error.message ? error.message : '未知错误')
    el.keyError.hidden = false
  } finally {
    el.btnSave.disabled = false
    el.btnSave.textContent = '保存并查询'
  }
})

el.keyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    el.btnSave.click()
  }
})

// 模式切换按钮
for (const btn of document.querySelectorAll('[data-mode-btn]')) {
  btn.addEventListener('click', async () => {
    const mode = btn.getAttribute('data-mode-btn')
    state.mode = mode
    syncModeButtons()
    await window.widget.setMode(mode)
  })
}

function syncModeButtons() {
  for (const btn of document.querySelectorAll('[data-mode-btn]')) {
    const isActive = btn.getAttribute('data-mode-btn') === state.mode
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false')
  }
}

// ESC 收起面板
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!el.settings.hidden) closeSettings()
    else if (state.expanded) setExpanded(false)
  }
})

// ---------- 启动 ----------

async function boot() {
  const info = await window.widget.init()
  state.mode = info.mode || 'pill'
  state.expanded = info.expanded === true
  state.hasKey = info.hasKey === true
  state.alwaysOnTop = info.alwaysOnTop !== false

  root.setAttribute('data-mode', state.mode)
  root.setAttribute('data-expanded', state.expanded ? 'true' : 'false')
  syncModeButtons()
  renderUsage()

  if (state.expanded && !state.hasKey) openSettings()

  await refresh(false)
  startPolling()
}

window.widget.onModeChanged((payload) => {
  if (payload && payload.mode) {
    state.mode = payload.mode
    root.setAttribute('data-mode', payload.mode)
    syncModeButtons()
  }
  if (payload && typeof payload.expanded === 'boolean') {
    state.expanded = payload.expanded
    root.setAttribute('data-expanded', payload.expanded ? 'true' : 'false')
  }
  renderUsage()
})

window.widget.onRefreshRequest(() => refresh(true))
window.widget.onOpenSettings(() => {
  setExpanded(true)
  openSettings()
})

// 每分钟刷新一次"同步时间"的相对显示
setInterval(() => {
  if (state.usage && !document.hidden) el.updated.textContent = relativeTime(state.usage.updatedAt)
}, 60000)

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.hasKey) refresh(false)
})

boot().catch((error) => {
  renderError('初始化失败：' + (error && error.message ? error.message : '未知错误'))
})
