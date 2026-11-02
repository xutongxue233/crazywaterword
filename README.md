# crazywaterword

微信小游戏《疯狂水世界》的**协议侧挂机工具**：不开游戏界面，直接用游戏自己的 WebSocket 协议完成
日常任务、领奖、英雄养成、海面世界的收成品/排产/交单/建造/升级，并附带一个本地网页控制台。

不是模拟器、不是图像识别、不是内存修改 —— 全程只收发游戏客户端本来就会发的那些报文。

---

## 免责声明

**本项目仅供协议分析与学习研究。使用它会违反游戏的用户协议，账号可能被处罚或封禁。**

- 所有请求都由你**自己的账号、自己的凭证**发出，作者不为任何后果负责。
- 请只用你自己的账号测试，**不要**用于批量、代练、工作室或任何形式的牟利。
- 项目刻意保留了一批「不做」的边界（见下方「安全边界」），例如不花钻石、不买付费礼包、
  不使用 `LoginRequest` 里 `testAccount` / `superToken` 这类开发者后门字段。
- 如果你不接受这些，请不要使用本项目。

---

## 它是什么

| 能力 | 说明 |
|---|---|
| 登录 | 用抓包拿到的真实凭证连接网关，支持多账号 |
| 任务 | 主线、支线、成就、每日订单档位奖励的自动领取 |
| 日常 | 17 项日常任务的自动完成 + 任务奖励 + 活跃度宝箱 + 每日免费赠礼 |
| 英雄 | 升级、升星、升技能（判定条件照抄客户端红点逻辑） |
| 海面世界 | 收成品、竣工、建造新建筑、交居民订单、按订单缺口排产、余料升级、加速 |
| 自动循环 | 上面三块按轮执行，可只读探测、可长期挂机 |
| 网页控制台 | 本地页面，中文业务视图，一键领取 / 一键完成 / 自动循环 / 账号与凭证管理 |

## 它不是什么

- 不做手机端抓包，不做云端同步。
- 不做资源田之外的地图争夺（占田需要舰队，多数账号不满足前置条件）。
- 不为没有图标的美术资源做手工绘制或猜测映射，找不到就退回纯文字。

---

## 环境要求

- **Node.js >= 20.11**（用到 `import.meta.dirname`），实测于 Node 22。
- Windows（微信 PC 端抓包走 HKCU 系统代理 + 当前用户根证书）。
- 唯一的运行时依赖：`protobufjs`。

```bash
npm install
```

首次使用请在电脑版微信进入《疯狂水世界》，让微信下载协议分包。程序优先读取本地解包的 `work/extracted/_src_chunks_/src/chunks/game.js`。如果缺少该文件，会直接读取当前用户微信缓存中版本号最高的 `_src_chunks_.wxapkg`，无需手动解包。
如果微信缓存位于自定义目录，可在 PowerShell 中设置 `$env:CW_PROTO_BUNDLE = "D:\游戏缓存\_src_chunks_.wxapkg"`（替换为实际路径，也支持解包后的 `game.js`）。运行 `npm test` 验证协议是否可用。

---

## 快速开始

### 1. 抓一份登录凭证

游戏不会把凭证交给外部程序，只能由本机代理从真实会话里抓：

```bash
node tools/capture-credentials.mjs
```

这一步会改动系统设置，所以**会先问你确认**，且改动全部限定在当前用户、随时可回滚：

- 起一个只监听 `127.0.0.1:17322` 的本地 MITM 代理；
- 把本地 CA 装进**当前用户**的根证书区（`certutil -user`）；
- 设置 **HKCU** 的 `Internet Settings` 代理。

确认之后，在电脑版微信里打开《疯狂水世界》，代理抓到 `LoginRequest` 就自动收工并回滚
（关代理、撤 CA），凭证写到 `data/credentials.json`。

也可以跳过 CLI，直接在网页控制台「账号」页点扫码添加 —— 同样的流程，带二维码与进度显示。

### 2. 启动控制台

```bash
node src/app.mjs            # 默认就是这个
```

浏览器打开 `http://127.0.0.1:17321`。页面上：

- **总览** —— 账号卡、资源与库存（带游戏自己的图标）、一键领取；
- **挂机** —— 工厂/订单/建筑/空位、资源田报告、执行一轮、自动循环开关；
- **英雄** —— 英雄卡片与养成计划；
- **日常** —— 日常任务表（中文，并说明「为什么不可做」）；
- **账号** —— 多账号切换、扫码添加、凭证查看（默认打码）。

---

## 命令行

```bash
node src/app.mjs <子命令> [参数]
```

| 子命令 | 作用 |
|---|---|
| `console`（默认） | 起本地网页控制台 |
| `selftest` | 离线自检（协议帧 / LZ4 / 账号仓库 / 素材索引 / 二维码 / 海面计划 / 活跃度宝箱 / 每日赠礼） |
| `probe` | 连接并长连，只观察服务端推送，不发任何业务请求 |
| `connect [秒]` | 连接并保持指定秒数 |
| `state` | 采集一遍只读状态集（`--raw` 原样、`--out` 写 `data/state.json`） |
| `worlds [worldId\|all]` | 账号下的区服列表与角色位置 |
| `accounts <list\|use\|label\|remove\|show>` | 多账号管理 |
| `config [表名]` | 列出本地配置表 / 打印某张表 |
| `actions` | 列出所有动作及其协议消息名 |
| `act <id> [k=v …]` | 手动发一条动作（改状态的要 `--yes`） |
| `loot [--dry]` | 一键领取：邮件、任务、成就、挂机、建筑产物/成品、活跃度宝箱、每日赠礼 |
| `tasks [--dry]` | 主线 / 支线 / 成就 / 每日订单档位 |
| `dailies [--dry] [--paid]` | 日常任务闭环 |
| `heroes [--dry]` | 英雄养成 |
| `world [--dry] [--speed-up] [--reroll]` | 海面世界一轮 |
| `field [gridIdx]` | 资源田报告 / 占田 / 弃田 |
| `loop [--rounds N] [--every 秒]` | 自动循环（`--rounds 0` = 一直跑） |

**任何会改变账号状态的命令都必须显式授权**：CLI 加 `--yes` 或 `CW_ALLOW_MUTATE=1`，
网页请求体里带 `confirm: true`。不加就只打印计划，一个字节都不发出去。

常用环境变量：`CW_ACCOUNT`（选账号）、`CW_PORT`（控制台端口）、`CW_DATA_DIR`、
`CW_CONFIG_PACK`、`CW_PROXY_PORT`、`CW_NO_BROWSER`、`CW_DEBUG`。

---

## 工作原理

### 通信

- 网关 `wss://dhyaoj-gate.khlgamen.com/ws`，首次连接直接发 `LoginRequest`，没有独立的挑战握手。
- 自定义帧：`int32 BE 长度` + `uint8 版本=2` + `int32 BE 序号` + `uint8 名称长度` + `ASCII 名称`
  + `uint8 标志`（0 = 原始，非零 = LZ4）+ protobuf 载荷。
- 协议定义来自客户端自带的 protobufjs **static module** 产物 —— 它没有任何反射元数据，
  字段号和字段名只能从生成的 `encode` / `decode` 函数体里读回来（`tools/describe.mjs`）。

### 账号与区服

- 账号身份是 `login.eworldParams.openId`；机密是同一处的 `token` / `sign` / `timestamp`。
- 网关不区分区服：一个 socket 服务整个账号，区服由 `LoginRequest.worldId` 选择。
- 选服界面的键是 `GameWorldInfo.worldId`（角色**出生**服），`roleInfo.worldId` 是**当前**服；
  合服之后两者不同，服务端会把出生服键解析到承接服 —— 不了解这一点会把合服误读成 bug。
- **一个账号同时只能有一条连接**：第二条会话登录会把第一条顶掉（`SCChannelExpired`）。多账号各一条。

### 数据来源

- **配置表**：客户端运行时从 CDN 拉独立 bundle `config_cn`（591 张表）。微信缓存里有副本，
  `tools/sync-config.mjs` 把它快照到 `work/cdn/`。游戏里的 itemId / heroId / buildingType
  本身就是中文字符串（`生鱼片`、`杰森`、`食品厂`）。
- **素材**：Cocos 远程 bundle 里的 FairyGUI 图集。`tools/sync-art.mjs` 从微信缓存还原文件名并镜像，
  `src/fgui.mjs` 从 `FGUI` 二进制里解出「名字 → 图集矩形」，页面直接用 CSS `background-position`
  裁切，不需要任何图像处理依赖。
- **地图**：资源田的 grid 数据只在客户端地图 bundle 里，`work/cdn/world_map.*.json`。
- 这些都在 `.gitignore` 里，不进仓库；缺了程序会如实降级而不是编造。

---

## 目录结构

```
src/
  app.mjs        CLI 入口与各子命令
  client.mjs     网关连接、心跳、请求/推送的路由与 prompt 归属
  codec.mjs      自定义帧 + protobuf 编解码
  proto.mjs      协议表加载
  accounts.mjs   多账号存储（data/accounts.json）
  config.mjs     配置表加载与资源名映射
  game.mjs       只读状态集
  tasks.mjs      主线/支线/成就/订单档位
  dailies.mjs    日常任务、活跃度宝箱、每日赠礼
  heroes.mjs     英雄养成
  world.mjs      海面世界：建造/工厂/订单/资源田
  loop.mjs       自动循环
  actions.mjs    动作目录（请求名、参数、是否改状态）
  server.mjs     HTTP + SSE，多会话
  page.mjs       控制台页面（单文件：CSS + HTML + 内联 JS）
  art.mjs        实体 → 图标名 → 图集矩形
  fgui.mjs       FairyGUI 二进制解析
  lz4.mjs        LZ4 解压
  selftest.mjs   离线自检
  vendor/        第三方单文件（二维码编码器，MIT）
tools/
  capture-credentials.mjs  抓凭证（CLI，带确认与回滚）
  mitm-proxy.mjs           本地 MITM 代理（CLI 与网页共用）
  mitm-ca.mjs              本地 CA 生成/安装/卸载
  proxy-settings.mjs       HKCU 代理读写与还原
  sync-config.mjs          镜像 config_cn
  sync-art.mjs             镜像 UI 贴图并建索引
  describe.mjs             从 static module 里读回字段
  build-names.mjs          抠出内联的 id→名字枚举
  wxapkg.mjs               解密并解包 PC 微信小程序包
  probe-*.mjs              只读探针
  selftest-*.mjs           工具侧自检
docs/
  gameplay.md    协议与玩法的详细记录（哪条结论是从哪段客户端代码/哪张表得来的）
```

---

## 安全边界

这些边界是**有意保留**的，不是还没做：

- 写操作一律要 `--yes` / `CW_ALLOW_MUTATE=1` / 网页 `confirm: true`，且在连网关**之前**就检查。
- **不花钻石**。加速只花「加速器」道具（`SpeedUpCostParam.type` 恒为 2；1 = 钻石、3 = 广告都不使用）。
  点金与折扣店默认跳过，要勾 `--paid` 才做。
- **不买任何付费礼包**（含 12 元那个「自动生产」礼包）。
- 建造/升级材料不齐时，客户端会弹「用钻石补」——本工具**不补**，跳过等下一轮。
- 默认**不拒单**（`--reroll` 才开，且跟客户端一样拒绝重刷）。
- **不使用** `LoginRequest` 的 `testAccount` / `superToken` —— 那是绕过鉴权的开发者后门。
- 抓包的系统改动只在**当前用户**范围内（`certutil -user`、HKCU），必须在网页上显式点确认，
  `try/finally` + 进程退出钩子保证回滚。
- 凭证是本机明文文件，「显示凭证」要在页面上点一次，默认打码。
- 账号的自动循环**每轮都是「先只读探测 → 算计划 → 再执行」**，所以没什么可做时计划自然为空，
  不会重复发同样的请求；被服务端拒过的动作会跨轮记住不再重试。

---

## 自检

```bash
node src/selftest.mjs
```

30 组离线检查，覆盖协议帧编解码、LZ4、账号仓库（迁移/选中/替换）、配置表与素材索引、
二维码、海面计划器（含建造与竣工互斥）、活跃度宝箱（日/周两套门槛）、每日赠礼。
工具侧另有 `tools/selftest-mitm.mjs`、`tools/selftest-describe.mjs`、`tools/selftest-registry.mjs`。

---

## 文档

深入细节都在 [`docs/gameplay.md`](docs/gameplay.md)：帧格式、协议表面统计、每一条结论背后的
客户端代码位置与配置表依据、以及踩过的坑（比如日/周活跃宝箱是两张不同门槛的表、
「每日赠礼」的 packId 在客户端里硬编码、建造与升级是两个不同的请求）。

---

## 许可

ISC（见 `package.json`）。`src/vendor/qrcode.mjs` 为第三方单文件，保留其原始版权头。
