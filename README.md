# Token Plan 桌面挂件

腾讯云 Token Plan 用量查询的**真正桌面悬浮挂件**。不依赖 DeepSeek Harness，直接调用 `https://token.m8bj.cn` 查询接口，常驻桌面右上/右下角。

## 为什么单独做这个

官方 `dsh-token-plan` 插件里的"悬浮"是 DSH 网页内的 `position:fixed` 浮层，只能在浏览器页面范围内显示，关掉 DSH 就消失。浏览器沙箱无法创建桌面级窗口，所以那个插件做不到真正的桌面悬浮。

这个挂件是独立的 Electron 应用，能真正浮在桌面上、置顶、可拖动。

## 使用

双击 `启动挂件.cmd`。

首次启动会在屏幕右下角出现一个胶囊，点它 → 输入你的 `sk-` 开头 API Key → 保存并查询。

## 三种形态

| 形态 | 尺寸 | 说明 |
|---|---|---|
| 胶囊 | 宽 76–190 自适应 × 36 | 单行显示已用百分比 + 状态点，**宽度随内容自动收窄** |
| 圆环 | 60×60 | 圆环进度 + 中心百分比，最省地方 |
| 迷你条 | 300×108 | 图标 + 百分比 + 进度条 + 剩余额度 |

在展开面板底部切换。展开后有两个标签页：

- **套餐概览**：剩余额度、已用/总额、额度状态、套餐周期、用量排名、同步时间
- **模型用量**：按今天 / 近 7 天 / 近 30 天统计各模型的估算积分

### 关于外观

小挂件**不投影**，只用 1px 描边勾勒轮廓。原因：窗口四周只有 4px 留白，`box-shadow` 的模糊半径一旦超过这个距离，就会被窗口边界直角裁断，在浅色背景下表现为一圈突兀的矩形灰框。展开面板不受此限制（窗口够大，留白足够），保留了轻微阴影。

鼠标悬停时只叠加一层极淡高光，**不替换底色**——否则深色模式下卡片会变半透明，桌面透上来就看不清了。

### 关于位置

三种形态切换、展开收起都按「锚定边缘」处理：卡片在屏幕右半则右边缘固定，在下半则下边缘固定，看起来是从同一个角伸缩。

⚠️ 胶囊高度必须是 **36px**。Windows 强制无边框窗口最小高度为 36px，设更小会被系统静默放大，导致锚点计算与实际尺寸不符，每次切换形态位置就往一个方向漂几像素。

### 额度状态判定

**不采用服务端返回的 `quotaExhausted` 字段**，而是用 `exclusiveQuota` 和 `exclusiveUsed` 自己算（BigInt 精确运算，与官方 DSH 插件算法一致）。

实测该字段会与实际数据矛盾——例：已用 516.90 / 总额 10,000（明显未耗尽），服务端却返回 `quotaExhausted: true`。若直接采信会误报“额度已耗尽”。

状态分级：未分配额度（总额 0）→ 额度已用尽（已用 ≥ 总额）→ 额度即将用尽（≥90%）→ 额度充足。

## 操作

- **单击**悬浮体 → 展开详情
- **拖动**悬浮体 → 移动位置（自动记住，重启保留）
- **托盘图标**右键 → 切换形态 / 总在最前 / 重新查询 / 设置 Key / 退出
- **托盘图标**左键 → 显示或隐藏挂件
- **ESC** → 收起面板
- 每 30 秒自动刷新；页面隐藏时暂停

## 数据与安全

- Key 只保存在本机 `%APPDATA%\token-plan-widget\config.json`（文件权限 0600）
- 请求路径：本机 → `https://token.m8bj.cn/api/me/usage`，使用 `Authorization: Bearer <Key>` 直连
- **不经过任何第三方中转**，不发遥测
- 注意：服务端要求请求**不带 `Origin` 头**（带 Origin 会被 403 拒绝），这是桌面端能直连、而网页端必须走同源代理的原因
- 界面字段做了白名单处理，上游异常内容不会直接渲染

## 技术细节

- Electron 45.3.0（自带 Chromium，无需额外 Node）
- 无边框 + 透明窗口 + `alwaysOnTop: 'screen-saver'`
- 托盘图标由 `build-icon.js` 用纯 Node 生成（无第三方依赖）
- 单实例锁：重复启动只会唤起已有实例

## 常见问题

**左键点了没反应？**
v1.0 初版有此问题，已修复。原因是用了 `-webkit-app-region: drag` 做窗口拖动，那种方式会让 Electron 吞掉该区域内的鼠标事件，`click` 传不到 JS。现改为指针事件手动拖动：位移小于 4px 判定为点击，超过则拖动，两者互不干扰。

**挂件突然消失了？**
旧版在窗口被关闭时无法阻止应用退出（`window-all-closed` 事件没有 `preventDefault`）。现已改为在窗口 `close` 时拦截并隐藏，并监听 `render-process-gone` 自动恢复。若仍消失，查看日志：
```
%APPDATA%\token-plan-widget\widget.log
```

**启动后没有窗口？**
确认 `node_modules/electron/dist/electron.exe` 存在。若删除过 node_modules，在项目目录执行 `npm install`。

**手动命令行启动时窗口不出现？**
环境里如果有 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node 进程。用 `启动挂件.cmd` 启动（脚本里已清除该变量），或手动 `set ELECTRON_RUN_AS_NODE=` 后再启动。

**提示"Key 无效"？**
确认 Key 以 `sk-` 开头且未停用/轮换。可先用 curl 验证：

```bash
curl -H "Authorization: Bearer sk-你的key" https://token.m8bj.cn/api/me/usage
```

**查询超时 / 连不上？**
检查代理设置。系统代理若拦截了 `token.m8bj.cn` 可能导致失败。

---

## 打包与分发

### 生成安装包

```bash
npm run dist:portable     # 便携版单文件 exe（推荐分发）
npm run dist:installer    # NSIS 安装包
npm run dist:dir          # 仅生成解包目录（调试用）
```

产物在 `dist/`：

| 文件 | 说明 |
|---|---|
| `TokenPlan-<版本>-portable.exe` | 便携版，单文件，双击即用，约 106MB |
| `TokenPlan-<版本>.zip` | 便携版 + 使用说明的压缩包，适合发群/网盘 |

### 图标

`assets/icon.ico` 由 `build-icon.js` 生成（纯 Node，无第三方依赖），包含 16/24/32/48/64/128/256 共 7 种尺寸。
要改图标就改脚本里的 `BRAND` 颜色和 `BOLT` 多边形坐标，然后 `npm run icon`。

### 打包时可能踩的坑

**1. 代理导致下载失败（502 / ETIMEDOUT）**

electron-builder 需要从 GitHub 下 `winCodeSign`、`nsis` 等二进制。如果网络走了会拦代理，会报：

```
⨯ Response code 502 (Bad Gateway)
⨯ connect ETIMEDOUT 20.205.243.166:443
```

解决办法（任选）：

- 清空代理变量后打包：
  ```bash
  HTTPS_PROXY= HTTP_PROXY= https_proxy= http_proxy= npx electron-builder --win portable
  ```
- 或手动把二进制丢进缓存 `%LOCALAPPDATA%\electron-builder\Cache\`：
  - `winCodeSign-2.6.0/winCodeSign-2.6.0-ia32-x64/`（解压后的内容）+ 同名 `.state` 文件
  - `.state` 格式：`{"version":1,"state":"complete","timestamp":<毫秒>,"fileCount":<n>,"extractedSize":<字节>}`
- 镜像源：`set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`

**2. `ELECTRON_RUN_AS_NODE=1` 导致 exe 双击无反应**

某些开发环境（含部分 IDE / 宿主工具）会注入这个变量。它让 Electron 退化为纯 Node 进程，**不创建窗口、不报错、直接退出**，表现为"双击没反应"。

排查：看 `%APPDATA%\TokenPlanWidget\boot.log` 有没有 `boot` 记录。没有就是这个问题。

终端里临时解决：`set ELECTRON_RUN_AS_NODE=` 后再运行。

**3. 便携版首次启动较慢**

便携版双击后会先把自身解压到临时目录（约 1-2 秒），这是正常现象。

### 代码签名

默认不签名，Windows 会提示"未知发布者"。要去掉这个提示需要购买代码签名证书（约几千元/年），内部小范围分享一般不需要。

### 数据目录

应用数据固定存在 `%APPDATA%\TokenPlanWidget\`（`main.js` 里用 `app.setPath` 写死，不随 productName 变化）：

- `config.json` — API Key、窗口位置、显示模式
- `widget.log` — 运行日志
- `boot.log` — 启动探针（排查启动失败用）
