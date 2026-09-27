# 一笔 - 交付报告

## 摘要

| 字段 | 值 |
|---|---|
| **App 名称** | 一笔 |
| 英文名 / 路由 | EULERTRAIL · `#/c/<n>`、`#/daily`、`#/random/<band>/<token>`、`#/lot/<id>` |
| 玩法一句话 | 在格点上把每条边描一遍，边不许重复；用不超过笔数上限的笔数覆盖全部边 |
| 难度口径 | `par = max(1, 奇点数 / 2)` —— 欧拉定理的下界与上界，另有 ≤14 边的穷举 DP 独立复核 |
| 测试钩子 | `window.eulertrail`（`state` / `theorem` / `pool` / `baked()` / `strokePath()` / `pinOf()` / `probe()` / `playStroke()` / `store` …） |
| 关卡 | 48 关（4 档 × 12），`js/data/lots.js`，构建期由 `tools/bake.mjs` 生成并三路复证 |
| 依赖 | `dependencies: {}`、`devDependencies: {}`（`node -e` 实测，见下） |
| 二进制资产 | 0（png/jpg/mp3/woff/ttf 全类型计数为 0；favicon 是 `data:,`） |
| node 断言 | 96 条，7 个套件，fail 0 |
| 浏览器断言 | 65 条，5 段（@boot 9 / @play 12 / @routes 15 / @save 10 / @pointer 19），fail 0 |
| 验收命令 | `npm run check` · `node --test test/` · `bash tools/verify.sh` |

依赖与资产的机器可判定检查（等价于组织审计里的两行）：

```bash
$ node -e 'const p=require("./package.json");const d=p.dependencies||{},v=p.devDependencies||{};
  process.stdout.write(Object.keys(d).length+Object.keys(v).length===0?"ok":JSON.stringify({d,v}))'
ok
$ find . -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.mp3' -o -name '*.woff*' -o -name '*.ttf' \) -not -path './.git/*' | wc -l
       0
$ grep -rlnE 'window\.|document\.' js/core/ | grep -v 'storage\.js$' | tr '\n' ' '
（空：core 层除 storage.js 外不碰 DOM）
```

## 文件清单与验证者

37 个文件。"由谁验证"只填**具体断言名**或**具体命令**，填不出验证者的行不写。

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `index.html` | 壳：顶栏 / 画布 / 右侧面板 / 结算幕 | `verify.sh @pointer` 第 1 条 `every control the shell reaches for exists`（19 个 id）；`@boot` 的 `the canvas has real pixels` |
| `css/game.css` | 全部样式 | `@boot` `the canvas has real pixels (not the 300x150 default)`（样式没生效时 canvas 就是默认尺寸）；`@save` `the shelf lets level two be clicked` |
| `js/core/graph.js` | 格点图模型：`compile` / `validate` / `toSpec` / `edgeBetween` | `test/graph.test.mjs`（18 条：不连通、奇数奇点、重复边、自环、非单位段、越界端点、超边数上限各一条负例 + 1000 随机图） |
| `js/core/theory.js` | 定理下界：`oddVertices` / `par` / `oneStrokeExists` / `fitsOnLattice` | `test/theory.test.mjs`（14 条，含 `par==1 ⟺ odd∈{0,2}` 正反例、七桥度数表、格点恒等式） |
| `js/core/construct.js` | 构造性上界：配对 → 虚边 → Hierholzer → 切迹 + `verify()` | `test/construct.test.mjs`（13 条，含 300 随机图"构造迹数 == 定理值"） |
| `js/core/bruteforce.js` | 穷举 DP（≤14 边）+ `firstMoveAudit` 错首手审计 | `test/bruteforce.test.mjs`（10 条，含"超上限诚实拒绝"与三路对账） |
| `js/core/game.js` | 一局的纯规则，三条口径的唯一执法处 | `test/game.test.mjs`（20 条）+ `@play` 12 条 + `@pointer` 19 条 |
| `js/core/geometry.js` | 格点 ↔ 像素双向映射、≥12px 容差、越界钳制 | `test/geometry.test.mjs`（12 条）+ `@pointer` `a pin 6px away is still the same pin, 30px away is no pin at all` |
| `js/core/make.js` | 生成器 + 生成侧难度梯 | `node tools/bake.mjs`（非法关卡直接抛错）、`node test/balance.mjs`（分位数表） |
| `js/core/library.js` | 已烘焙池子查表：战役 / 每日 / 随机 / id / `stats()` | `test/library.test.mjs` `the pool loaded`、`daily and shared-link picks are reproducible`；`@boot` `the shipped pool loaded` |
| `js/core/rng.js` | FNV-1a 种子哈希 + mulberry32 | `test/library.test.mjs` 的确定性断言；`@routes` `a seed only picks an index…` |
| `js/core/storage.js` | 单键 localStorage 存档 + 无 window 退化 | `test/library.test.mjs` 的 4 条存档断言（含 `SAVE_KEY` 键名与原始字符串读取）；`@save` 10 条 |
| `js/data/lots.js` | 48 关构建期产物 | `test/library.test.mjs` `序列化复证: every row re-proves odd, par, cover and DP from its serialised spec`；`node tools/bake.mjs` 逐字节复现（md5 见下） |
| `js/view.js` | canvas 绘制 + 指针手势，只提问不判定 | `@pointer` 全部 19 条（真实 `Input.dispatchMouseEvent`） |
| `js/main.js` | 路由、DOM、存档写入、`window.eulertrail` 钩子 | `@boot` / `@play` / `@routes` / `@save` 四段共 46 条 |
| `server.cjs` | 零依赖静态服务器 | `tools/verify.sh` 的 web root 轮询（`static server never answered` 分支）+ `@boot` |
| `electron/main.cjs` | 桌面壳 | `npm run check`（语法）；运行期未自动化 —— 见未实现清单 |
| `tools/bake.mjs` | 内容管线：生成 → 序列化 → 三路复证 → 入库 | `node tools/bake.mjs`（不一致即抛错；本次重跑输出与原文件 md5 相同） |
| `tools/playtest.mjs` | 零依赖 CDP 驱动 + 五段浏览器套件 | `tools/verify.sh` 每段打印的 `rows: N fail: []` |
| `tools/verify.sh` | 一次性验收门（含同机 Chrome 排队门） | 自身：末行 `=== ALL GREEN ===` |
| `tools/harness.mjs` | 微型测试框架，node/浏览器同一输出形状 | 每个 node 套件的 `rows: N fail: M` 行（审计脚本按它计数） |
| `test/fixture.mjs` | 手算 fixture（SINGLE / PATH3 / CYCLE4 / STAR4 / FIG8 / FOUR_ODD） | 被 5 个 `.test.mjs` import；每条 fixture 的数字由 `test/graph.test.mjs` `the hand-built fixtures all pass the validator with their own numbers declared` 复算 |
| `test/balance.mjs` | 生成器器架（非断言） | `npm run balance`；输出被本报告"数字从哪来"引用 |
| `package.json` | 脚本与零依赖声明 | `npm run check`、`npm run unit`、上面那条 `node -e` |
| `.github/workflows/ci.yml` | unit（语法 + 套件）/ browser（`SKIP_UNIT=1`） | 语法文件集与 `npm run check` 的 glob **逐字相同**（见下"CI 对齐"） |
| `.github/workflows/pages.yml` | Pages 部署 | 只 `cp index.html`、`cp -r css js`，`path: _site`（不拷 `.`） |
| `.gitignore` / `LICENSE` | 忽略规则 / MIT | 人工核对（`node_modules`、`*.log`；MIT © 2026 z-biz-game） |
| `README.md` / `DESIGN.md` / `deliverable.md` | 文档 | 组织审计的名称正则：README 首行取到的中文名与本报告 `App 名称` 行完全一致（都是「一笔」） |

## 数字从哪来

`node tools/bake.mjs`（2026-09-27，本机，Node v26.8.1）真实输出，含每档进度与总耗时：

```
tandem: 12/12  1s
three:  12/12  1s
four:   12/12  2s
five:   12/12  2s
wrote 48 levels (tandem:12 three:12 four:12 five:12) -> js/data/lots.js
elapsed 6s
```

重跑前后 `js/data/lots.js` 的 md5 相同（`1ce20f2e5b895e57909ac7f8ec249a42`），所以"构建期产物"是可复现的而不是
一次性巧合。每档 par 固定（2/3/4/5），入库实测：

```
node -e "import('./js/core/library.js').then(m => console.log(m.stats()))"
tandem n12 par2-2 edges9-14 verts8-12 forks3-5 dead0-2 badRatio0.5-0.75  states 3033/32759/152565
three  n12 par3-3 edges10-14 verts9-12 forks4-6 dead1-2 badRatio0.385-0.571 states 6712/69110/147445
four   n12 par4-4 edges13-14 verts11-13 forks5-6 dead1-2 badRatio0.286-0.462 states 68086/109045/157684
five   n12 par5-5 edges13-14 verts12-13 forks6-6 dead1-2 badRatio0.154-0.357 states 70133/151028/155636
```

生成器体检 `node test/balance.mjs`（每档 40 个种子，`real 10.29`）：

```
tier   par accept edges p0/25/50/75/100   badRatio p0..p100            cut  ms med/max  dpStates max  rejects
tandem 2   40/40  9 / 11 / 12 / 13 / 14   0.50/0.55/0.60/0.64/0.69     0.50 19 / 137    155637        offBand 34 tooCorridory 8 tooFlat 7 tooObvious 5
three  3   40/40  10 / 12 / 13 / 13 / 14  0.36/0.42/0.45/0.50/0.58     0.36 42 / 146    150517        offBand 47 tooFlat 11 tooObvious 9 tooCorridory 4 invalid 1
four   4   40/40  11 / 12 / 13 / 14 / 14  0.25/0.29/0.36/0.38/0.50     0.25 54 / 203    157684        offBand 110 invalid 5 tooObvious 5 tooFlat 3 tooCorridory 2 exhausted 1
five   5   40/40  12 / 13 / 14 / 14 / 14  0.15/0.15/0.21/0.29/0.36     0.15 106 / 155   155636        offBand 877 exhausted 47 tooFlat 15 invalid 12 tooObvious 5 tooCorridory 1
```

读法：种子级通过率 40/40（撒一张连通图算 `par` 很便宜），但**难度是筛出来的**——五笔档 40 个种子内部拒了
877 张不在带上的图，单关耗时中位因此从 19 ms 涨到 106 ms、最差 203 ms，穷举 DP 单关最多 157,684 个状态。
这组数就是"生成只在构建期跑"的全部理由。带间 `badRatio` 切点（0.50/0.36/0.25/0.15）取自上面那张表的 p25 列，
写进 `js/core/make.js`，再由 `tools/bake.mjs` 用实际入库关卡写 `TIERS_META`。

复现命令：`node tools/bake.mjs`、`node test/balance.mjs`、`node -e "import('./js/core/library.js').then(m => console.log(m.stats()))"`。

## 改动表（先写错在哪 → 为什么对）

接手时 `node --test test/` 有 6 条断言红。判定原则：**用外部数学事实裁决**（连通性/奇度、迹的定义、
`construct` 与 `bruteforce` 的对账），禁止把期望值改成实现吐出来的东西。结论：5 条是期望值写错，
1 条是核心 bug（也是唯一一处核心改动）。

| # | 曾经的错误 | 错在哪 | 为什么现在是对的 | 证据 |
|---|---|---|---|---|
| 1 | `the pen may only start where an undrawn edge leaves` 里 `eq(beginStroke(game,0).ok, false)`（`expected false`） | 测试前提为假：在 `SINGLE`（单边图）上 `beginStroke + endStroke` **从不落笔**，只有 `stepTo` 会画边，`endStroke` 对 0 边的空中笔不提交，所以那个点的边依然是未画状态 | 断言改成"原地按抬之后同一图钉还能起手"（`ok true`），另用活的 `STAR4` 测真正的"该点无未画边"分支：叶子-中心-叶子走完自动抬笔后，叶子 3 被 stranded 而中心 4 仍有两条出路。全画完的分支另用 `SINGLE` 走完 `stepTo` 之后测，理由字符串断言为 `complete` 而非 `no undrawn edge` | `test/game.test.mjs:46-70`；`js/core/game.js:122-129`（`endStroke` 的 `if (!cur.edges.length) return {committed:false}`） |
| 2 | `FIG8` 那关 `eq(visits, 3, …)`（`expected 3`） | 与它自己旁边的 fixture 文本矛盾：欧拉闭迹 `0-1-4-5-8-7-4-3-0` 里图钉 4 只出现两次 | 度数论证：闭迹每穿过一个顶点消耗它的两条边，`deg(4)=4 ⇒ 穿过 deg/2 = 2 次`。期望改为 2，并把推导写进注释 | `test/game.test.mjs:20-25,108-112`；`js/core/theory.js` 的度数表；`test/theory.test.mjs` `degreeTable reports per-pin degrees` |
| 3 | `口径 2: dragging over an already drawn edge does nothing at all` 的 `expected 3` | baseline 取错位置：在第二笔**合法**地画完 `5→4` 之前就快照 `before`，然后把随后被拒的 `4→3` 归咎于覆盖率变化 —— 断言测的是"被拒那一步前后"，不是"这一笔开始前后" | `before` 移到紧贴被拒那一步之前（先 `beginStroke(5); stepTo(4); eq(covered,3)` 再快照）；同时把"什么都没发生"拆成三条可判定的：覆盖不变、`drawn` 数组逐位不变、`again` 事件恰好 1 条 | `test/game.test.mjs:135-156`；浏览器侧同一口径由 `@pointer` 两条断言复测 |
| 4 | `hint …` 里期望 `kind === 'diverged'`（`expected 2`） | 期望值本身算错了：`mk('four')` 的烘焙迹是 `[[1,4],[0,1,2,5,8]]`，测试画的 `8-5-2` 只是迹 2 的尾巴，迹 1（单边 `1-4`）完全没动 —— 此时"从 1 起笔"仍是合法且可走完的建议，`fresh` 才是诚实的回答 | 双向都测：先断言尾部偏离之后仍为 `fresh` 且指向未画边，再构造真正的 diverged 状态（补完迹 1、然后进入迹 2 的第一条边且**不抬手**），断言 `kind='diverged'`、`stroke=2`、`note` 里印着第几笔、且指的就是 `baked[1].edges[1]` | `test/game.test.mjs:287-315`；`js/core/game.js:175-206`（hint 走烘焙迹，不重解） |
| 5 | 同一套件里 hint 的 `there is still a hint`（拿到 `null`） | 是第 4 条的连带：改错方向时把 `FOUR_ODD` 的 5 条边全画完了，于是"还有提示"确实为假 —— 说明原测试对状态的描述本来就自相矛盾 | 现在第三条笔停在 `0→1` 且不抬手，`edge 1` 仍未画，提示存在且必须是 `diverged`；断言链完整覆盖 `fresh → fresh → diverged → null(已胜)` | `test/game.test.mjs:305-320` |
| 6 | `strokesUsed counts the stroke in the air` 的 `expected 1`（**核心 bug**） | `js/core/game.js` 里 `strokesUsed = strokes.length + (cur && cur.edges.length ? 1 : 0)`：空中那笔只有画了边才占预算，与 `beginStroke` 自己的注释"一次按压就是一笔新的笔"矛盾，面板会在玩家还有一笔可花时少报一格 | 改为 `strokes.length + (cur ? 1 : 0)`（唯一一处核心改动）。"按下去一步没走"仍然**不记账**，因为那是 `endStroke` 的职责（不提交 0 边的笔），两件事各归各位；`grade/judge/store` 仍用 `g.strokes.length` | `js/core/game.js:57-64`；`test/game.test.mjs:348-358`；浏览器侧 `@pointer` 的 `a press that never moves draws nothing and bills nothing` 与 `one mouse drag … costs exactly one stroke` 两头都钉住 |

同一轮里另外四处接线修正（都不是规则改动）：

| 位置 | 错在哪 | 现在 |
|---|---|---|
| `js/main.js` `playStroke()` | 把 `endStroke()` 的返回值当"这一笔有没有落纸"。`#/c/1` 的第一条烘焙迹只有一条边，走完即 stranded、由 `stepTo` 内部自动抬笔，随后的 `endStroke` 无笔可提交而回报 `false` —— 状态里明明多了一笔，钩子却说没落纸（`@play` 第 2 条因此红） | `committed` 由 `g.strokes.length` 的前后差决定，抬笔本身的结果另放 `lift` 字段 |
| `js/main.js` `sync()` / `finish()` | rAF 循环只在拖拽/提示/闪白时重绘，纯钩子路径（`playStroke`/`playAll`）改了状态却不重绘画布，验收截图拍到没有墨的棋盘 | 两处末尾各补一次 `view.redraw()` |
| `js/core/storage.js` `SAVE_KEY` | 导出后无人使用的悬空导出（审计的 ghost 检查点名的那条） | `test/library.test.mjs` 用它做键名断言并从原始后端 `ls.getItem(SAVE_KEY)` 读回整份存档；审计的 ghost 扫描现在输出 `none` |
| `server.cjs` 启动日志 | 从标杆仓抄来时写着 "Gridlock served" | 改为 "Eulertrail served at …" |

## 验收结论

`npm run check`（与 CI unit job 的语法步骤同一文件集）：

```
$ npm run --silent check
OK
```

`node --test test/`（7 个套件，逐套件的 `rows:` 行即审计脚本的计数来源）：

```
--- test/bruteforce.test.mjs   rows: 10 fail: 0
--- test/construct.test.mjs    rows: 13 fail: 0
--- test/game.test.mjs         rows: 20 fail: 0
--- test/geometry.test.mjs     rows: 12 fail: 0
--- test/graph.test.mjs        rows: 18 fail: 0
--- test/library.test.mjs      rows:  9 fail: 0
--- test/theory.test.mjs       rows: 14 fail: 0
ℹ tests 7  ℹ pass 7  ℹ fail 0
```

`bash tools/verify.sh`（node 套件 + 真实 headless Chrome；末行是判定，逐段 `rows:` 是计数）：

```
=== syntax ===  OK
=== node suites ===   （7 个套件同上，rows 合计 96，fail 0）
boot lot: tandem-01
=== @boot ===     rows: 9  fail: []
=== @play ===     rows: 12 fail: []
=== @routes ===   rows: 15 fail: []
=== @save ===     rows: 10 fail: []
=== @pointer ===  rows: 19 fail: []
=== win shot ===  {"id":"tandem-01","par":2,"play":{"outcome":"won","strokes":2,"covered":12,"total":12},
                   "grade":{"key":"perfect","label":"一笔不浪费", …}}
=== console ===   (none)
=== ALL GREEN ===
```

`@pointer` 的 19 条全部通过 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` 派发真实输入，页面内 JS
改状态的一条都没有：两笔完整拖出 `tandem-01`（12 条边、4 个奇点、par 2）并判赢、`★★★ 一笔不浪费` 上幕布、
成绩落盘 `best === 2`；随后断言按住不动不记账、按在非图钉处不启动、拖过湿墨不计数不记账且必须回报 `again`、
斜向甩出棋盘 720px 只画出真正跨过的那一条边（`probe` 同时回报 `clamped: true`）、超 `par` 判负但撤销能重新
打开棋盘、`u/h/r` 真实按键生效。

浏览器截图（人眼核对过：画布有像素、图钉与粗线在位、面板印出 `定理 2 · 构造 2 · 穷举 2`、
通关幕布是 `★★★ 一笔不浪费` 且棋盘上有两色墨）：

- `/tmp/puzzle-brief/shots/eulertrail-boot.png`
- `/tmp/puzzle-brief/shots/eulertrail-win.png`

CI 对齐：`.github/workflows/ci.yml` 的 unit job 语法步骤是
`for f in js/*.js js/*/*.js server.cjs electron/main.cjs tools/*.mjs test/*.mjs; do node --check "$f"; done`，
与 `package.json` 里 `check` 的 glob **逐字相同**；套件步骤 `for f in test/*.test.mjs` 与 `npm run unit` 相同；
browser job 用 `SKIP_UNIT=1` + `WD_TIMEOUT: 240` 跑 `bash tools/verify.sh`。
`.github/workflows/pages.yml` 只拷 `index.html`、`css`、`js` 到 `_site`，`path: _site` —— 没有 `path: .`，
测试、生成器、服务器与 electron 壳不会进站点产物。

## 未实现清单

- **Electron 桌面壳未做自动化验收**：`electron/main.cjs` 只过语法门（`npm run check` 与 CI 的语法步骤包含它）。
  跑它需要 `npm i -D electron`，与"零依赖"硬约束冲突，所以本仓不装、不测，只在 README 里写怎么自己跑。
- **GitHub Pages 线上验收未在本轮执行**：`pages.yml` 已按产物规则审过（只拷三个路径），但部署与
  线上 URL 的实测由主代理推送后做。
- **超过 14 条边且带穷举证据的关卡**：`bruteforce.MAX_EDGES = 14` 是诚实边界，面板会印"边数超过穷举上限"。
  入库 48 关全在 9–14 条边，所以每条都有三路证据；想要更大的图需要另一个可复核的证据来源。
- **中国邮递员 / 最少重复路径、斜边、三维、限时、笔顺唯一性**：规格 §7 明确不做，理由见 `DESIGN.md` 第 9 节。
- **音效、彩带、成就、排行榜**：不做。`best` 恒等于 `par`（`storage.js` 头注释解释了为什么它不是高分榜），
  排行榜没有可比量；分享只有一个把 `#/lot/<id>` 写进剪贴板的按钮。
- **每日题不按玩家进度调节难度**：从整池挑，没有账号体系就不做需要状态的东西。
- **`test/balance.mjs` 不是通过/失败门**：它是器架，只打印分位数；带切点由人读表后写进 `make.js`，
  切点与入库结果的一致性才由 `test/library.test.mjs` 断言。
- **命名口径与派单文本不一致（照规格执行，此处声明）**：派单给的 README 首行样例是 `# 一笔画径 · EULERTRAIL`，
  但同一份派单写明"如果规格里另有中文名，以规格为准"，而 `eulertrail.md` 的中文名是「一笔」。
  本报告与 README 都用「一笔」，两处完全一致（审计的 `name match` 判据即取这两处比对）。

## 线上验收（GitHub Pages，主代理 2026-09-27 实抓）

发布 sha `4e656b1`，CI trigger `624aa99`；本地门禁由主代理自己的 `audit.sh` 复核：
`npm run check` rc=0、node **96 条断言 / 0 失败**、浏览器 **65 条 / 0 失败**、zero-deps、0 个二进制资产、
`core purity clean`、`unwired exports none`。

| 资源 | 结果 |
| --- | --- |
| `/`（index.html） | 200 / 3,264 B |
| `js/main.js` | 200 / 22,097 B |
| `css/game.css` | 200 / 6,655 B |
| `js/data/lots.js` | 200 / 24,954 B |
| `<title>` | `一笔 · EULERTRAIL`，与 README 首行一致 |

真实浏览器渲染（`https://z-biz-game.github.io/z-biz-game-eulertrail-cos/`，2026-09-27 09:53Z）：

- canvas 后备缓冲 `1384x1130`，CSS 盒 `692x408`（devicePixelRatio 2 生效）；
- `getImageData` 全量采样 1,563,920 个像素，其中 **1,152,644 个非近黑**（73.7%），出现 **143 种不同 RGB**
  —— 图形与顶点和路径都真的画出来了；
- `window.eulertrail` 暴露 **27 个键**（`version state pool theorem load vertexPoint edgeAt …`）——
  其中 `theorem` 直接在线上是可查的：本仓库的"难度"来自欧拉迹存在性定理（奇度顶点数 ∈ {0,2}），
  不是形容词；
- 控制台 **0 条消息**（无 error / warning；`index.html` 用 `<link rel="icon" href="data:,">`，
  浏览器不发 favicon 请求，故该断言未被 404 噪音污染）。

诚实边界：以上是"结构 + 像素统计"级证据（在已发布页面里跑 `evaluate_script` 取 `getImageData`），
不是逐帧视觉截图比对；本次未产出 PNG，仓库保持 0 个二进制资产。
