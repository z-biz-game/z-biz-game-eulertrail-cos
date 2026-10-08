# 设计文档 · 一笔

面向接手的代理。这里只写"为什么长成这样"和"改哪里会坏"，不复述 README 的玩法介绍。
每个数字都注明它是哪一次运行量出来的，以及用哪条命令复现。

## 1. 核心决策：笔数是定理，不是搜索预算的副产品

`par = max(1, odd/2)`。这不是"我们觉得这一关大概两笔"，而是：

- **下界**：一条迹只有两个端点，而每个奇度顶点必须是某条迹的端点 ⇒ `2k ≥ odd`。
- **上界**：把奇点两两配对、加虚边连成欧拉图、跑 Hierholzer 得到一条欧拉回路、再按虚边切开 ⇒
  恰好 `odd/2` 条边不重复的迹覆盖全图。`odd == 0` 时回路本身不用切，所以取 `max(1, …)`。

两条都在仓里跑着：`js/core/theory.js` 是陈述，`js/core/construct.js` 是上界的**构造**。
只有陈述的仓库会在某一天悄悄印出一个做不到的数字，所以"屏幕上的数真的画得完"这条必须有可执行的证据。
第三条路 `js/core/bruteforce.js` 是**独立的**下界证据：在 (剩余边集, 笔尖位置) 的状态空间上做记忆化 DP，
真把最小迹数搜出来，和定理值对账。三者不一致就是 bug，`tools/bake.mjs` 对此抛错而不是丢关卡。

### 1.1 为什么构造器不能省

`construct.coverWith()` 输出的 `trails` 就是关卡数据里那一列，也就是**提示功能走的那条路**和
`@pointer` 用真实鼠标拖完的那条路。省掉构造器，提示就得在点击时现搜（见第 4 节，那是禁止的），
浏览器验收也没有"这条 par=2 的解真的存在"的可拖对象。

### 1.2 为什么穷举只在 ≤14 条边上跑

`bruteforce.MAX_EDGES = 14`，超过就返回 `{ ok: false, truncated: false, skipped: true }` 并说明原因。
状态数是 `2^m · |V|` 量级，实测每关最多 157,684 个状态（见第 10 节），14 条边已经是要跑一秒级的东西。
**这条边界是诚实性设计**：`js/data/lots.js` 里每一行的 `states` 都是真跑出来的，`exhaustiveAllowed()`
为假时面板印"边数超过穷举上限"而不是印一个空值。把 `MAX_EDGES` 调大不会让任何一关变难，只会让
"更少笔数做不到"这句话失去证据。入库的 48 关全在 9–14 条边之间，所以每一关都有这条证据。

## 2. 全局约定（破坏即出 bug）

### 2.1 一笔 = 迹：边不许重复，顶点可以

`game.stepTo()` 是唯一把边标记为已画的地方。走到一个未画邻居为 0 的顶点，这一笔**自己结束**（口径 1）：
`stepTo` 内部调用 `endStroke` 并回报 `autoEnded: true`。这不是便利，是定理的前提 —— 笔尖卡住了却还
"握着一笔"，玩家就再也开不了下一笔，`par` 的定义也就假了。

破坏点：任何"抬手才算一笔结束"的改动都会让 `@pointer` 的 `strokes === 1` 断言翻转，也会让
`test/game.test.mjs` 的"走到死地自动抬笔"那条红。

### 2.2 拖过已画边 = 什么都不发生，但必须留名字

`stepTo` 对已画边返回 `{ ok: false, reason: 'drawn', edge }`，并在事件流里记一条 `{type:'again'}`。
覆盖数不变、笔数不变、不算失败、不锁棋盘；视图拿这个名字闪一下白线。
"什么都不发生"和"什么都没回报"是两件事：前者是规则，后者是玩家看不见理由。`@pointer` 两头都断言：
覆盖与笔数逐字不变，且 `again` 事件数**增加**（否则说明那次拖拽根本没走到规则里）。

### 2.3 两个笔数：`strokesUsed` 与 `game.strokes.length`

这是全仓最容易改错的一对数，写清楚：

| 数 | 定义 | 谁在用 | 为什么 |
|---|---|---|---|
| `strokesUsed(g)` | `g.strokes.length + (g.cur ? 1 : 0)` | 面板"已用笔数"、`hint()` 的 `stroke` 编号、`test/game.test.mjs` | 按下去的那一刻笔已经在纸上，预算行必须替它预留一格，否则显示"还能用 1 笔"而玩家其实已经用完 |
| `g.strokes.length` | 真正落纸的笔数 | `grade()`、`judge()` 的判负、`store.finish({strokes})`、`@pointer` 的 `committed` | 按下去一步没走就抬手，`endStroke` 不提交任何东西；把它记账等于惩罚一个没发生的行为，判负也不该由它触发 |

`beginStroke()` 的注释写着"一次新的按压就是一笔新的笔"，`strokesUsed` 必须与它一致。之前这里只算
`g.cur.edges.length ? 1 : 0`（在空中但还没画边的笔不计），于是"按住在原地不动"这一格预算凭空消失，
`test/game.test.mjs` 的 `counts the stroke in the air` 就是抓这个的。**改 `strokesUsed` 之前先读那条测试。**

### 2.4 三层不许互相串

- `js/core/*` 是纯的：没有 `window.`、没有 `document.`（`storage.js` 是唯一例外，它存在的意义就是
  守卫 `globalThis.localStorage`，并且用 `try/catch` + 能力探测，无 window 时退化成内存对象）。
  这条由 `tools/verify.sh` 之外的审计把守：`grep -rlnE 'window\.|document\.' js/core/`。
- `js/view.js` 只把指针位置翻译成 `beginStroke/stepTo/endStroke` 的**请求**，自己不改状态。
  `sweep()` 在两个采样点之间按 `max(4, cell/3)` 步长插值，每个候选图钉都"递给规则"，不合法的（不是当前
  顶点的邻居、已经画过）被拒。这就是 `@pointer` 有意义的原因：派发真实鼠标事件测的是这段接线，
  而不是规则本身。
- `js/main.js` 是唯一的记账处：路由、`store.finish`、幕布、`window.eulertrail` 钩子。
  钩子里的 `playStroke()` 走的是同一组 `beginStroke/stepTo/endStroke`，所以 `@play` 与 `@pointer`
  不是两套游戏。

### 2.5 判定合法性的地方只有一个

`js/core/game.js`。`view.js`、`main.js`、`tools/playtest.mjs` 都只能问，不能答。任何"在视图里先挡一下"
的优化都会让 node 测试与浏览器测试测到不同的游戏。

### 2.6 所有循环都要有上限

`bruteforce` 的 `MAX_EDGES` 与 `force` 旗标、`make.js` 的 `probes/restarts`、`bake.mjs` 的
`s < PER_TIER * 40`、`game.events` 的 400 条滚动上限、`playtest.mjs` 的 `waitShell` 预算（默认 30s）、
`verify.sh` 的 watchdog（`WD_TIMEOUT`，默认 420s）。这个仓没有任何一处"跑到算出来为止"。

## 3. 生成：为什么是"撒一张连通图 + 副维度筛"

`js/core/make.js`：随机生成树保证连通，再随机加边到 `edges` 区间；`odd → par` 直接落进目标带
（这一步接受率极高，规格里也承认："高接受率 + 难度不可控"才是本仓的风险）。所以筛子加了三条副维度：

- `forks`：度 ≥ 3 的顶点数（分叉密度）；
- `dead`：度 1 顶点引出的死链数；
- `badRatio`：**错首手比例** —— `bruteforce.firstMoveAudit()` 枚举每一条有向起手边，逐条走完之后重算
  "还能不能用 `par` 笔覆盖完"，走不完的就是坏首手。这是本仓唯一能横向比较的难度实数。

四档的 `minBadRatio` 依次是 0.50 / 0.36 / 0.25 / 0.15，**随 par 上升而下降**。这不是随手调的：
`badRatio` 的分母是"有向起手边数 = 2 × 边数"，边越多的图起手越多、蒙对的概率也越大，所以同一绝对值在
高 par 档代表更高的难度。带间的切点由 `node test/balance.mjs` 的 `badRatio` 分位数表读出来（第 10 节
有那一次运行的整行输出），写进 `js/core/make.js` 的生成侧 `TIERS`，再由 `tools/bake.mjs` 用**实际入库**
的关卡量出显示侧 `TIERS_META`。`test/library.test.mjs` 断言两者不重叠、且每关的 `badRatio ≥ 本档 cut`。

## 4. 为什么生成不在浏览器里跑

规格与 CONTRACT 都禁止"点击时无界搜索"。本仓允许的边界是：**构建期把三条路全跑完，运行期只做查表
与一次性的定理复算**。实测（`node test/balance.mjs`，每档 40 个种子，2026-09-27，Node v26.8.1）：

| 档 | 种子通过率 | 单关耗时 中位 / 最差 | DP 状态数最大 | 内部拒绝计数（前二） |
|---|---|---|---|---|
| tandem | 40/40 | 19 ms / 137 ms | 155,637 | offBand 34 · tooCorridory 8 |
| three | 40/40 | 42 ms / 146 ms | 150,517 | offBand 47 · tooFlat 11 |
| four | 40/40 | 54 ms / 203 ms | 157,684 | offBand 110 · invalid 5 |
| five | 40/40 | 106 ms / 155 ms | 155,636 | offBand 877 · exhausted 47 |

`js/core/library.js` 与 `tools/bake.mjs` 的头注释引用的是同一台器架更早一次运行的读数
（中位 18–112 ms、最差 235 ms），量级一致；机器负载会推动这些数，所以两份都标了出处，别拿一个当承诺。

两个要点：

1. **通过率 40/40 不等于便宜**。五笔档为了长出一关，内部平均要拒掉 22 张图（877/40），每拒一张都要重算
   一次首手审计。把它放在玩家按下"换一张图"之后，就是 100 ms 起步、偶发 200 ms+ 的白屏，而且是在
   主线程上、没有任何进度条的地方。
2. **运行期唯一允许的"算"是 `theoremFor()`**：`js/main.js` 里它对当前关卡算一次（定理 + 构造 + ≤14 边的
   穷举），结果挂在 `app.proof` 上按 `lot.id` 缓存，切关才重算。它是有界的、每关一次的，不是点击时的
   无界搜索；`hint()` 更是完全不搜 —— 它走 `baked` 里那条已经复证过的迹。

`npm run bake` 重跑一次全池要几分钟（48 关 × 每关一次穷举 DP，见 `deliverable.md` 的实测行），
这就是"内容管线在构建期"的价格。

## 5. 序列化复证到底复证了什么

`test/library.test.mjs` 对 `js/data/lots.js` 的每一行做这件事：

1. `JSON.parse(JSON.stringify(row.spec))` —— 从**序列化之后的产物**出发，不许借用生成器留在内存里的图；
2. `validate(spec, { odd, par })` 必须返回 `null`；
3. `oddCount(g)` 与 `par(g)` 必须等于行里印着的数字（"从序列化之后的产物重解必须复现印着的数字"）；
4. `verify(g, row.trails)` 必须为 `null`（`par` 条迹、边不重复、并集 = 全边集、每步都是真边）；
5. `minTrails(g).trails` 必须等于 `par`，**并且 `dp.states` 必须等于行里印着的 `states`** ——
   状态数是这条复证的指纹：图的结构只要变一个字节，DP 走过的气味就不同，数字就会动。

48 关合计 4,300,177 个状态，套件跑约 4.5 秒。手改 `lots.js` 里任何一个字段都会红，包括看起来无害的
`states` 与 `badRatio`（后者由 `shapeStats()` 与 `firstMoveAudit()` 重算）。

## 6. 确定性

`hashSeed()`（FNV-1a）+ `mulberry32()`，没有 `Math.random()` 参与任何进池子的决定：

- 每日：`dailyLot(todayKey())` ⇒ `hashSeed('daily|YYYY-MM-DD') % 48`；
- 分享：`randomLot('random|<tier>|<token>')`，`#/random/four/4kq2` 在任何设备上同一关；
- 裸 `#/random` 会**把 token 写回 URL**（`location.replace`），否则一条链接在两台机器上是两张图；
- 战役顺序 = 入库顺序 = 档内按 `badRatio` 降序，所以第 1 关是全池最容易走错起手的那张；
- `levelAt()` 对池子长度取模回绕，`#/c/99999` 钳到最后一关而不是白屏。

## 7. 存档

单键 `eulertrail.save.v1`，值是 plain JSON。三条不变量各自有测试，且都是从**原始字符串**读回来验的
（`ls.getItem(SAVE_KEY)`），不是从 store 的 getter 读：

- `best` 只会变小或不变（`Math.min(prev.best, used)`）；`unlocked` 只会变大；
- `stars` 由**最近一次**尝试决定（连打三次输三次就是 0 星，历史最好成绩不能替它遮丑），
  但 `solved` 一旦为真就不回头；
- 清档真的 `removeItem`，并且要两次点击（第一次只是 arm + toast）。
- 没有 localStorage（`file://`、隐私窗口、node）时退化成内存对象，行为完全一致 —— 这条是
  `test/library.test.mjs` 里 `?no-localstorage` 那次 fresh import 测的。
- 解析失败（手改坏 JSON）= 干净开局 + 把修好的结构写回去，不是崩。

注意 `SAVE_KEY` 是被测试使用的（键名断言 + 原始后端读取），不是装饰性导出。
另：Node 25+ 会往 `globalThis` 上挂一个实验性的 `localStorage` 访问器，测试里必须先
`Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true })` 再谈"没有 window"。

## 8. 验证台架

### 8.1 为什么是 CDP 而不是 Playwright

零依赖是硬约束。`tools/playtest.mjs` 只用 Node 21+ 的全局 `WebSocket` 与 `fetch`，约 520 行，
包含 target 创建/附着、`Runtime.evaluate`、`Input.dispatchMouseEvent`、`Page.captureScreenshot`。

### 8.2 `@pointer` 为什么必须存在

这个玩法 100% 依赖拖拽接线：坐标 → 图钉 → 规则请求。页面内 JS 改状态证明不了这条链，所以 `@pointer`
里 19 条断言全部走 `Input.dispatchMouseEvent`：按住 → 每段边插值 3 个采样点 → 抬手。坐标一律向页面要
（`pinOf(v)` / `strokePath(i)`），测试自己不复算几何，否则测的是测试的算术。
覆盖：两笔完整拖完一关 par=2 并判赢、拖过湿墨不计数不记账且必须回报 `again`、按在非图钉处不启动、
按住不动不记账、超预算判负但不崩、撤销能重新打开棋盘、`u/h/r` 真实按键、6px 命中 / 30px 不命中、
斜向甩出棋盘 720px 之后只能画出指针真的跨过的那一条边（`probe` 同时回报 `clamped: true`）。

### 8.3 导航之后等的是 shell，不是秒表

页面是一张 module 图。固定 sleep 在 localhost 上够、在冷启动或 GitHub Pages 上不够，症状是
`window.eulertrail` 还没挂上、canvas 还是 300×150 的默认值，然后 `@boot` 第一条就红。
`waitShell()` 轮询 `window.eulertrail.state.id`（有下限 300–600ms，避免本地变慢），
`verify.sh` 在跑套件之前也轮询一次 boot lot。

### 8.4 一台机器同时只允许一个 headless Chrome

`verify.sh` 开头有一道排队门：`pgrep -f remote-debugging-port` 非零就每 `CHROME_RETRY`（默认 60）秒重试，
超过 `CHROME_WAIT`（默认 600 秒）直接退出 6，什么都不跑。原因不是礼貌：第二个实例要么抢不到
`CDP_PORT`（然后每个 eval 都打到**别人那个**不含本游戏的浏览器上，报一堆假失败），要么抢 profile 锁。
软渲染还会把核心吃满，把隔壁仓的浏览器阶段一起拖死。

### 8.5 verify.sh 的几处非显然处理

- `UDD=$(mktemp -d)`：绝不复用 Chrome profile，否则上一次崩溃留下的锁文件让浏览器再也起不来。
- `trap cleanup EXIT` + `kill -9` 之后对每个后台 PID `wait`：不 wait 会在 stdout 上留孤儿输出，
  也会让脚本先退而 Chrome 后死。
- watchdog 子 shell 重定向 `</dev/null >/dev/null 2>&1`：它会继承脚本的 stdout，在管道里跑
  （`bash tools/verify.sh | tee`）时把写端一直握住，消费者永远等不到 EOF。
- 每段套件的 JSON 结果用 python 做**大括号计数**截取：CDP 的 console 噪音、`--- console ---` 尾巴、
  Node 的 warning 都会混进 stdout，`json.loads(stdin)` 会炸。
- `SKIP_UNIT=1` 支持：CI 的 browser job 不重复跑 node 套件（那是 unit job 的事）。
- `<link rel="icon" href="data:,">` 必须在 `index.html` 里，否则每次导航都有一条 favicon 404，
  `verify.sh` 的 console 段就永远是脏的。

### 8.6 钩子的两条回报口径（本仓踩过、已修）

`window.eulertrail.playStroke(i)` 原来把 `endStroke()` 的 `committed` 直接当"这一笔有没有落纸"回报。
`#/c/1` 的第一条烘焙迹只有一条边（58→59），走完就 stranded，于是 `stepTo` 内部自动抬了笔，
后面的 `endStroke` 无笔可提交而回报 `false` —— 状态里明明多了一笔，钩子却说没落纸。
现在 `committed` 由 `g.strokes.length` 的前后差决定，抬笔本身的结果另放在 `lift` 字段里。
同一次修复还补了 `sync()` / `finish()` 末尾的 `view.redraw()`：rAF 循环只在拖拽/提示/闪白时重绘，
纯钩子路径改了指尖位置却不改像素，验收截图会拍到一块没有墨的棋盘。

## 9. 已知不做

- **中国邮递员 / 最少重复路径**：要加权匹配，而且与本仓"边不许重复"的口径直接冲突。这里的失败只有
  一种来源：笔数用完。
- **斜边**：模型只承认单位横竖线段（`graph.validate` 直接拒非单位段）。加斜边会让 `edgeAtLocal` 的走廊
  互相重叠、让 `odd = 2·(1 + forks − cycles)` 这类格点恒等式失去意义，而定理本身不给任何回报。
- **三维、限时、笔顺唯一性**：`par` 只保证存在某个 `par` 笔的覆盖，不保证唯一解；提示走的是烘焙迹，
  不是"唯一正解"。
- **超过 14 条边且仍带穷举证据的关卡**：见 1.2。
- 音效、彩带、账号、云存档、排行榜：`best` 恒等于 `par`（见 `storage.js` 头注释），排行榜没有可比量。

## 10. 实测出的边界

- 第 4 节的表是 `node test/balance.mjs`（默认 `SAMPLES=40`）在 2026-09-27 的一次运行，
  四档种子通过率都是 40/40，单关最差 203 ms，DP 状态数最大 157,684。
- 池子的实测区间（`js/data/lots.js` 的 `TIERS_META`，由 `tools/bake.mjs` 写）：
  边数 9–14、图钉 8–13、岔口 3–6、死胡同 0–2、`badRatio` 0.154–0.75、`states` 合计 4,300,177。
- 生成侧想要的边数区间是 9–14（`make.js` 的 `edges`），入库结果落在 9–14 之内；两者不一致时以入库为准，
  这条由 `test/library.test.mjs` 的带不重叠断言把守。
- 复现：`node test/balance.mjs`、`node -e "import('./js/core/library.js').then(m => console.log(m.stats()))"`、
  `node tools/bake.mjs`（会重写 `js/data/lots.js`，种子固定所以结果可 diff）。

## 实测校正（2026-10-08 追加）

上面 1–4 节保持**提案原文**：本仓的文档行号腿（`tools/docs-test.mjs`）按行号引它们作证据，往中间插一行就让那批引用
整批漂到隔壁句子。这一节量的是落地之后的树，与提案不同处以下面为准。

- **笔数上限来自定理而不是投票**：`par`（`js/core/theory.js:33-35`）就是 `max(1, odd/2)`，空图返回 `null`——
  给一关无边打印「0 笔」是说谎；烘焙期的对账在 `declared` 那道检查（`js/core/graph.js:86`），序列化出来的 `par` 与定理值不等就抛。
- **穷举只在有限边数以内做**：`firstMoveAudit`（`js/core/bruteforce.js:104`）带迭代上限，超预算的关卡不是被丢掉而是进不了池子。
- **零依赖的代价写在存档那一层**：`js/core/storage.js`（190 行）在没有 `window` 时退化成内存对象，
  双击 `index.html` 打开与 CI 的 headless Chrome 走的是同一条代码路径。
