# 万卷（wanjuan）设计文档 v0.2.1

**Amikar设计的一个上下文压缩管理器。**
日期：2026-11-13 · 状态：设计稿 v0.2.1 · 目标宿主：DeepSeek Harness（DSH desktop/next）

> 命名：读书破万卷。上下文像卷轴一样一折一折收起来，需要时再展开——「折叠」正是这套思路的核心动作。
> 本文只做三件事：①思考承重设计；②吸收正在修的 bug 作反面教材；③给出一个小内核、可读、可改、bug 有归宿的 DSH 插件形状。

**v0.2 → v0.2.1 增补**：补 decompress 原文存储硬矛盾（§5 新增 `blocks/<id>.raw.jsonl`）；补 `unitPrice` 字段口径（§3.2）；新增第 7 条强断言「原文可达」；新增 §14 开放问题清单。

**v0.1 → v0.2 变更摘要**

| 变更 | 原因 |
|---|---|
| §3.1 ledger 永不裁剪，裁剪只作用 snapshot | 消除事件溯源被误裁的崩溃路径 |
| §3.2 三段管线（raw→k̂→偏置）+ 先验 k̂ + nudgeReserve | 防偏置被 k̂ 抵消；冷启动不裸奔；头寸不漏 |
| §3.6 miss 分「预期内/异常」两层；miss 移入 requests.jsonl | 防「new 吞掉一切」重演 68% 无法归因 |
| §5 Block 加 promotedInto；tier 比率相对本层输入；不变式收敛 | 消除晋升重复计数；防不变式膨胀 |
| §6 nudge 尾部追加 + 内容标记；紧急路径不剥夺拒绝权；decline_compress + 忙碌排除 | 守前缀纪律；守模型驱动；降频有可判定信号 |
| §7 patch inject 整列表替换；decompress 尾部追加；search 块粒度；宿主依赖与降级清单 | #20 血泪教训；缓存纪律；万轮会话可行性 |
| §8 新增度量类验收；§9 里程碑加「覆盖验收项」；P0 哲学定稿前置；M1 收窄 | 上线节奏即 bug 暴露策略 |
| §11 ADR、§12 不修清单、§13 最小化原则与六项度量 | 「修好」与「压到最小」的诚实边界 |
---

## 0. 一句话

**历史只追加、压缩只停用、摘要可单独恢复、判断交给模型、账本记清每一分钱、每个 bug 有归宿。**

---

## 1. 设计目标与不做什么

目标（继承 BC，全部保留）：

1. **有界上下文**：总上下文在窗口内震荡而非增长；20 万窗口可跑数月、万轮会话。
2. **只压增量**：每轮只压「上次压缩以来新增且已被任务消费」的内容，从不重写全史。
3. **模型驱动**：压什么、何时压、压多少由模型按任务状态决定；模型有拒绝权。
4. **可恢复**：任何被折叠的内容都不丢弃，按块可 search、可 decompress。
5. **缓存友好**：append-only 布局保证 KV 前缀永不因压缩失效；未命中逐笔归因。
6. **信息留存率 R∞ > 0**：每段内容一生只被折一次，留存率恒定 ~1/8。

**bug 目标（v0.2 新增，与功能目标并列）**：

7. **不累积**：一个 bug 不跨轮放大。
8. **不静默**：bug 必留证据。
9. **可归因**：出问题能定位到类。
10. **孤立**：一个模块崩不传染。

不做（明确放弃，换来小内核）：

- 不做多宿主代理层。万卷是 DSH 专属插件。
- 不做自带 KV 存储引擎与迁移。
- 不做免训练之外的 SFT 路线。
- 不做极端压缩档作为默认。
- **不追求「零 bug」。** 追求「bug 有归宿、损失有上界」（§12/§13）。

---

## 2. 继承清单（BC 的承重设计，原样保留）

| # | 机制 | BC 的参数/事实 | 万卷沿用 |
|---|---|---|---|
| 1 | 折叠布局 | 开头摘要块区 + 近期原文区（~50K 软区） | 同布局 |
| 2 | 增速门 | 增长下限 50K tok；有效下限 = 下限 × 0.45 ≈ 22.5K | 默认同值，可配 |
| 3 | 受控提示词（nudge） | 压缩瞬间注入，用完即撤 | 同机制（**尾部追加区**，见 §6.4） |
| 4 | 不告知填充比例 | 告知比例 → 模型锚定拒绝压缩 | 硬规则 |
| 5 | 拒绝权 | nudge 是效率提醒不是溢出警告 | **紧急路径也不剥夺**（§6.3） |
| 6 | 推荐列表带真实尺寸 | token 数/消息数/tool:text 构成 | 是 |
| 7 | 唯一消息编号 | mNNNNN 稳定引用 | 同款 marker |
| 8 | 哲学文本（KEEP/DROP） | KEEP/DROP 规则详见 BC 论文 | 全文继承，**版本化 + P0 中文定稿**（§9） |
| 9 | 摘要上限 | 单块中位 185 tok，97.5% ≤2K；硬顶 2K | 是 |
| 10 | 分层蒸馏 | tier-1 ~1/8 → tier-2 ~1/4 → tier-3 ~1/3 | 比率相对**本层输入**（§5） |
| 11 | 紧急路径 | 用量 ≥95% 走紧急压缩；硬截断最后防线 | **不剥夺拒绝权**（§6.3） |
| 12 | search + decompress | 查块摘要+原始消息；不扰动缓存前缀 | **search 块粒度**，decompress **尾部追加**（§7） |
| 13 | 工具即抄（absorb） | 工具结果带 [absorb] 指令 | 是 |
| 14 | 瞬态注意力 | compress 调用期间待压区间浮现，调用完隐藏 | 是 |

---

## 3. 重新设计的部分

### 3.1 存储：一个写入者、一条日志、无上限错配

**BC 的病**（#6477、#6476、#6464）：快照按字节预算时保旧丢新；8MiB 超后端 4MiB 上限；规范化摘要丢字段导致假去重。

**万卷方案**：

- 存储两层，职责严格分离：
  - `sessions/<sid>/ledger.jsonl` —— **唯一事实，只追加，永不裁剪、永不重写、永不删除**。
  - `sessions/<sid>/snapshot.json` —— **纯派生缓存**，可由 ledger 全量重放重建。删掉零损失。
- **裁剪只发生在 snapshot 层**：全量重放 → 按新近度裁剪（永远从最旧丢，最新 N 条必在）→ 写 snapshot，不写回 ledger。
- 因此 #6477「保旧丢新」**结构上不可能**。
- 会话状态按块分片：`blocks/<blockId>.json` 单块单文件；块写入前尺寸断言（<4MiB）。
- ledger 增长有界：单会话 >100MB 时分卷（`ledger.0001.jsonl`…），分卷**只切不裁**。
- `canonical(v)`：按**字段白名单 + 固定顺序**序列化；未知字段不进哈希；写死过滤 `__proto__` / `constructor` / `prototype` 三个键。

> → test: `store.test.mjs` — ①重放后最新 N 条必在 snapshot 预算内；②删 snapshot 后由 ledger 重建状态 hash 相等；③分卷后重放一致；④块 >4MiB 断言失败不落盘。

### 3.2 估算器：一个口径、按模型分域、三段管线

**BC 的病**（#6460、#6474、#6467、#6463、#6473）：口径分裂；重复计费→假预检；k̂ 不分域；模型表缺项→匿名默认。

**万卷方案**：

- **一个口径原则**：`estimate(request)` 是唯一估算函数；触发、fits、nudge 推荐列表、账本全部调它。作用域 `(provider, model)`，键 `JSON.stringify([provider, model])`，**无全局 k̂**。
- **三段管线（顺序不可换）**：

~~~text
est_raw   = Σ 分类计数 × unitPrice              // 不含校准、不含偏置
khat      = 贝叶斯混合（n<5）/ 纯 observed（n>=5）// 无样本时 = khatPrior
est_cal   = est_raw × khat
est_final = ceil(est_cal × 1.05)                // 保守偏置最后应用
fits      = est_final ≤ window − output − nudgeReserve
~~~

  - k̂ 样本 = `usage.input_tokens ÷ est_raw`（**只除 raw**）。误除 est_final 会让稳态 k̂ → 1/1.05，偏置被抵消。
  - **k̂ 两段式**：n<5 时 `(n·obs + m·prior)/(n+m)`（m=5）；n≥5 时纯 `obs`。先验只服务冷启动，样本充足后必须让 observed 无偏接管。
  - n<5 的请求标 `calibrating: true`，月报单列。
  - `nudgeReserve` 取本次实际注入值，不做常数上界。
- **消息分类计数器**：`{text, tool, sys, dev, history_sys, history_dev}`，`history_sys/dev` 全会话只计一次（防 #6474）。
- **模型表**：`models.json` 外置，字段 `{window, output, khatPrior, unitPrice}`，与 tier-gate 读同一张表。查不到时**明着降级**：128K + warn，绝不悄悄钳 output。
- **unitPrice 字段**：M1 全为 1（等价纯 token 计数），代码先不乘；M2 回填真实单价后启用乘法，口径仍只此一处。
- 保守偏置理由：假预检代价是白压一次，真溢出是整个请求 400——不对称。**偏置必须在校准之后**。

> → test: `estimate.test.mjs` — ①k̂ 收敛后 `est_final ≥ 真值 × 1.05`；②跨模型互不污染；③n=0 时 ratio ∈ [0.95, 1.20]；④3MB 历史偏差 <15%；⑤CI 只允许一处 `usage / est_raw` 除法。

### 3.3 side-lane：主线之外的请求一律挂牌

**BC 的病**（#6475）：title-gen sidecar 被退化轮门误判，in-band error 写进会话标题。

**万卷方案**：

- 一切非主线请求必须带 `sideLane: {kind}` 标。
- 退化轮门、miss 归因、增速门、哲学注入**全部跳过** side-lane。
- 兜底：拿不到 call config 时尾部挂 marker 并在发前剥掉，记 `degraded: sidelane-marker`。

> → test: `side-lane.test.mjs` — 100 条假 title-gen → 主线零污染；marker 兜底降级计数 +100。

### 3.4 外部变更：append-only 是假设，对账是义务

**BC 的病**（#6469）：宿主原生压缩后 BC 不知道，stale blocks → 哈希碰撞 + thought_signature 400。

**万卷方案**：

- **轻指纹每轮**（条数 + 首末 id + 总字节），失配 → `reconcile()`。
- **采样对账**（防「保首末三点、换中间」假阴性）：距上次全量 >10 轮 / 出现 `rewrite` / 宿主版本变更时，中间随机抽 3 条比 hash。采样失配 → 全量。
- **每周强制全量 reconcile 一次**。
- reconcile O(n) 字节比较，200K 会话 <1ms。
- 永不假设「上一轮我看到的下一轮还在」。

> → test: `reconcile.test.mjs` — ①吃掉 30% 中史 → 指纹失配 → 重算无 stale block；②换中间 1 条 → ≤10 轮捕获归因 rewrite；③周全量幂等。

### 3.5 会话级开关与 kill-switch 连坐

**BC 的病/教训**（#6462、#3662）：没有按会话禁压缩；gate 差点被 kill-switch 连坐。

**万卷方案**：

- 配置三层：包默认 → profile patch → **会话覆盖**（`session-config/<sid>.json`）。
- 入口拆分从第一天起两个：`wanjuan-native`（压缩内核+工具）与 `wanjuan-gate`（退化轮门服务）。禁用 native 时 gate 必须活着，preset 回落到宿主原生压缩而不是永远 pending。

> → test: `session-config.test.mjs` — ①会话覆盖关压缩后增速门不触发；②禁用 native 时 gate 仍响应、preset 回落成功。

---

### 3.6 诊断是内核组件，不是外挂报表

每次请求记一行到 `sessions/<sid>/requests.jsonl`（**独立于 ledger**——ledger 只放状态变更，requests 是 diagnose 输入）：

~~~ts
type Req = {
  n: number; t: number;
  input: number; cached: number; new: number;
  estBy: number;              // 本次 estimate 的 est_final
  khat: number;
  calibrating: boolean;       // n<5
  missKind: MissKind;
  missTok: number;
  degraded: string[];         // 本次触发的降级项（§7 宿主依赖）
  divergeAt?: { msgId: string; bytes: number };  // seam 探针
};
~~~

**missKind 两层分类**（修正点：`new` 不能和异常混一个分母）：

| 层 | kind | 含义 |
|---|---|---|
| 预期内 | `new` | 正常新增内容 |
| 预期内 | `compress-repay` | 压缩后布局变更的一次性重付 |
| **异常** | `ttl` | 缓存过期 |
| **异常** | `switch-model` / `switch-effort` / `switch-key` | 切换事件对齐 |
| **异常** | `rewrite` | 既有消息被改写（前缀纪律违例） |
| **异常** | `restart` | 进程重启 |
| **异常** | `abort` | 中止后 30s 内重发（单列） |
| **异常** | `seam` | 渲染缝（`divergeAt` 已记录） |
| **异常** | `provider-miss` | 上游有状态中继侧未命中 |
| **异常** | `unattributed` | 归因树走到底且置信度 <0.5 |

**分级归因**：每个 miss 给「最可能原因 + 置信度」。`unattributed` 定义为置信度 <0.5 的集合；低置信里再按「是否有 wire 字节分歧」二分。

**月报两个健康指标**：`命中率`（含 new 的正常口径）与 `异常 miss 率 / 异常 token 量`。只报前者会把「new 吞掉一切」误读成健康。

> → test: `diagnose.test.mjs` — ①new 与异常 miss 分列；②abort 不并入 ttl/seam；③置信度分层可断言。

### 3.7 小内核

- **可读内核 ≤ 5000 行**（零依赖或仅依赖宿主）。模块边界：`observe / ledger / estimate / gate / nudge / compress / restore / diagnose / store / dsh`。
- 每个模块必须有单测 + `*.failure.test.mjs`（失败注入用例），全部 `node --test` 裸跑。
- 打包产物不背备份文件。

> → test: `bundle.test.mjs` — 产物内不含 `*.bak`；行数断言 ≤5000。

### 3.8 bug 归宿表

每个已知病在万卷里有明确归宿，四类：**结构消除 / 护栏消除 / 降概率 / 宿主管（有降级契约）**。

| # | 病 | BC 现场 | 归宿 | 万卷对策 | 守护测试 |
|---|---|---|---|---|---|
| 1 | 保旧丢新 | #6477 | **结构消除** | ledger 永不裁剪；裁剪只作用 snapshot | 重放后最新 N 条必在 snapshot 预算内 |
| 2 | 存储上限错配 | #6477 | **结构消除** | 无 KV 引擎；块分片单文件 | 块写入尺寸断言 |
| 3 | 哈希假等 | #6476 | 护栏消除 | `canonical()` 白名单+固定顺序 | 键序无关、未知键不参与哈希 |
| 4 | 侧道污染 | #6475 | 宿主管 | sideLane 标 + 全门跳过 + 降级契约 | 100 条假 title-gen 零污染 |
| 5 | 重复计费 | #6474 | 护栏消除 | `history_sys/dev` 全会话只计一次 | 3MB 历史偏差 <15% |
| 6 | 口径分裂 | #6460 | 护栏消除 | 唯一 estimate 函数 | CI import 点检查 |
| 7 | 校准串门 | #6467 | **结构消除** | `khat[JSON.stringify([p,m])]` | 跨模型互不污染 |
| 8 | 模型表缺项 | #6473 | 宿主管 | `models.json` 外置 + 明着降级 | 未知模型告警断言 |
| 9 | 窗口钳制 | #6463 | **结构消除** | 单表驱动，无第二处窗口常量 | 全表模型窗口不越表值 |
| 10 | 外部变更失明 | #6469 | 降概率 | 轻指纹 + 采样对账 + 周全量 | reconcile 测试 |
| 11 | 校验风暴 | #6464 | 降概率 | 重放/重吸每 tick 预算 ≤2MB | 10 万事件单帧 <50ms |
| 12 | 看门狗半吊子 | #6464 | 降概率 | 升级阶梯 warn→kill worker→kill pg→自救 | 假死注入逐级触发 |
| 13 | 头寸双扣 | #6464 | **结构消除** | 头寸是账本单一条目；fits 显式扣 nudgeReserve | 不变式 sum+active+reserve ≤ window |
| 14 | 图像重测缺失 | #6464 | 宿主管 | offload 使该消息缓存失效，下轮强重估 | offload 后 est 变化断言 |
| 15 | 媒体漂移 | #6464/#6356 | 宿主管 | 稳定 content-id；MEDIA REFS 原样保留 | 拆分媒体重取一致 |
| 16 | 图像绑定错位 | #6464 | **结构消除** | 图像块绑定表 keyed by 消息 id | multipart 组装单测 |
| 17 | 零折误判 | #6464 | 护栏消除 | 退化轮门把「零折叠」当合法结局 | 门单测含零折样本 |
| 18 | 工具循环静默完成 | #6471/#6465 | 护栏消除 | cap 触发**必须**产出可见 final | cap 注入：回合必带 final |
| 19 | id 规范化 | #6472 | **结构消除** | id 规范化单一出口 | id round-trip 测试 |
| 20 | preset 依赖丢失 | #6470 | 护栏消除 | inject 整列表替换 | cordis_inspect 核对 |
| 21 | 假确认/回显 | 本会话实测 | 降概率 | 状态变更只经工具；marker 行剥除 | 假 marker 剥除测试 |
| 22 | 代际漂移 | 本会话实测 | **结构消除** | 引用带代际戳；切换后旧引用拒绝解析 | 切模型后旧引用拒解析 |
| 23 | 整批原子失败 | 本会话实测 | 护栏消除 | 预检各块尺寸；失败指名哪块为什么 | 超限块错误含块号与原因 |
| 24 | 中止尾巴 | 本会话实测 | 宿主管 | abort 后 30s 重发单列 | 归因树单测含 abort 样本 |
| 25 | 有状态上游校验 | 本会话实测 | 宿主管 | per-route render 开关 | 路由配置单测 |

**归宿统计**：结构消除 8 · 护栏消除 7 · 降概率 4 · 宿主管 6。

> **诚实声明**：这张表不是「全部修好」。结构消除的 8 条写错代码也复现不了；护栏消除的 7 条漏一次就复现；降概率的 4 条只是压低频率；宿主管的 6 条随宿主契约漂移。§12 与 §13 是这张表的诚信对偶。

### 3.9 不确定性的三个出口

内核允许存在的不确定性只有三种，且都必须**外推到明确出口**，不在内核里猜：

| 不确定性 | 出口 | 检验 |
|---|---|---|
| 模型决策（压什么/拒什么） | 哲学 + 工具 + `decline_compress` + 忙碌排除 | 内核里任何「if 模型可能……」式猜测都是 bug 源 |
| 上游行为（provider miss/中继状态） | missKind 归因 + 降级契约 + 降级率可观测 | 每个降级路径必须有计数 |
| 环境变化（宿主压缩/升级/改配置） | 轻指纹 + 采样对账 + 全量 reconcile | 指纹算法本身是单点，配采样与周全量兜底 |

> → test: `determinism.test.mjs` — grep 内核，禁止在决策路径出现 `guess|assume|probably|maybe` 语义的静默分支。

---

## 4. 分层架构

~~~text
┌─ L4 宿主集成（dsh.ts）────────────────────────────┐
│  两个 bundle entry：wanjuan-native / wanjuan-gate   │
├─ L3 执行（compress.ts / restore.ts）──────────────┤
├─ L2 决策（gate.ts / nudge.ts / philosophy.ts）────┤
├─ L1 账本（ledger.ts / blocks.ts / fingerprint.ts）┤
├─ L0 观测（observe.ts / estimate.ts / diagnose.ts）─┤
├─ L-1 存储（store.ts）──────────────────────────────┤
└────────────────────────────────────────────────────┘
~~~

依赖方向严格向下：L2 只能调 L1/L0，L3 只能被 L4 调，任何模块不得向上回调。

---

## 5. 数据结构与不变式

> **v0.2.1 增补**：v0.2 原稿 §1 目标 4 承诺「任何被折叠的内容都不丢弃」，但 `Ev.msg` 与 `Block` 均未存原文，decompress 无数据可取——这是硬矛盾。本节新增 `blocks/<id>.raw.jsonl` 存放原文，明确它不是缓存而是**第二事实源**：fold 时写入，与 ledger 的 fold 事件同事务（写 raw 成功后才 append fold 事件）。

~~~ts
type Ev =
  | { k: "msg";    id: string; at: number; bytes: number; tok: number; cls: "text"|"tool"|"sys"|"dev"; gen: number; }
  | { k: "fold";   block: string; range: [string, string]; srcTok: number; sumTok: number; tier: 1|2|3; rawRef: string; note?: string; }
  | { k: "unfold"; block: string; why: "context"|"file"; }
  | { k: "evict";  ids: string[]; why: "reconcile"|"host-compact"; }
  | { k: "promote"; parent: string; children: string[]; srcTok: number; sumTok: number; tier: 2|3; }
  | { k: "cfg";    patch: object; by: string; }
  | { k: "seg";    from: string; to: string; }      // ledger 分卷点

type Block = {
  id: string;            // b1, b2, ...
  tier: 1|2|3;
  range: [string,string];
  srcTok: number;        // 本块压缩的【输入】尺寸：tier-1 = 原文 tok；tier-2/3 = Σ children.sumTok
  sumTok: number;        // 本块摘要自身 tok
  summary: string;       // ≤2K tok 硬顶
  topics: string[];      // 检索关键词
  children?: string[];   // tier-2/3 谱系
  promotedInto?: string; // 有值即不再是叶子，不参与账平
  rawRef: string;        // 指向 blocks/<id>.raw.jsonl（原文第二事实源）
  createdAt: number;
  gen: number;           // 代际戳
};

// blocks/<id>.raw.jsonl 每行一条原始消息
// { id: "m0042", at, cls, content: <原始内容>, gen }
~~~

**原文存储约束（v0.2.1 新增）**：

- `raw.jsonl` 只追加、不重写；与 ledger 同级的事实源，**删 snapshot 不影响它**。
- 写入顺序：先写 `raw.jsonl` 落盘并 fsync → 再 append `fold` 事件（含 `rawRef`）。若 fold 事件写失败，raw 成为孤儿，由 `reconcile()` 回收。
- `decompress(blockId, "context")` 从 `raw.jsonl` 读原文，**尾部追加**为 tool result；`decompress(blockId, "file")` 转存到指定路径。
- tier-2/3 晋升**不再写新的 raw**：父块的「原文」就是其 children 的 summary 集合，decompress 时递归展开叶子块的 raw。保证每段原文一生只存一份。

**tier 比率定义（修正分母歧义）**：

- tier-1：`sumTok ≈ srcTok × 1/8`（工具主导 ≈ 1/24）；
- tier-2：输入 = Σ 一组 tier-1 块的 `sumTok`，`sumTok ≈ 输入 × 1/4`；
- tier-3：同理，`sumTok ≈ 输入 × 1/3`。

每层比率都相对**该层输入**。原文消息一生只被 tier-1 折一次——此即「留存率恒定 ~1/8」的含义。

**不变式收敛（3 硬核 + 4 强断言）**

**硬核不变式（违反即拒绝该操作，不允许落盘）**

1. **重放可行**：snapshot 可由 ledger 全量重放重建；删除 snapshot 零损失。
2. **前缀字节纪律**：nudge 只追加在 messages 尾部区；hide-after-consume 只删除尾部连续 nudge 区；decompress 尾部追加；任何操作不改变其前消息字节。
3. **头寸唯一**：`sum(reservations) + active + nudgeReserve ≤ window`；任何模块只引用账本 reservation，不许另算。

**强断言（违反时 loud 告警 + 记录，但不阻塞当前操作）**

4. **账平**：`Σ(叶子块 srcTok) + Σ(活跃消息 tok) = 会话累计消费 tok`（叶子 = 无 promotedInto）。
5. **归属唯一**：任何消息 id 要么 active，要么属于恰一个 block（fold 后 evict 除外，evict 必带 why）。
6. **并发唯一**：同一会话同时最多一个未决 compress（违反时第二者排队而非拒绝，但告警）。
7. **原文可达**（v0.2.1 新增）：任何块的 `rawRef` 必须指向存在的 `raw.jsonl`；孤儿 raw（有 raw 无 fold 事件）由 reconcile 回收并计数。

> → test: `invariants.test.mjs` — 硬核违反 → 操作拒绝；强断言违反 → 记录 + 告警计数，不中断；随机 1 万步事件序列（含 tier 晋升路径）后 7 条全成立；孤儿 raw 注入 → reconcile 回收且计数 +1。

---

## 6. 压缩管线

1. **观测**：请求后记 usage → 更新 k̂（样本除 est_raw）；指纹失配 → reconcile。
2. **增速门**：`grown = est_final(现) − est_final(上次折叠点)`；`grown < 50K` 且用量 <85% → 静默。85–95% 降门到 0.45×（有效下限 22.5K）。
3. **紧急路径（≥95%）**：门降到 0、nudge 语气升级、推荐列表标红、**模型仍可拒绝**。压缩永远由模型发起；硬截断是唯一内核强制后手。
4. **nudge 注入（瞬态，尾部追加区）**：
   - nudge 追加在 **messages 尾部追加区**（最后一个 user 消息之后的新增区，不插历史中段）；
   - 每条带唯一标记 `wj-nudge-<n>`（n 单调递增）；
   - 内容 = 哲学节选 + 候选区间（id 范围、tok 真值、消息数、tool:text 比、主题）+ 明示「效率提醒，非溢出警告；可拒绝」；**不含填充比例**；
   - nudgeReserve 取本次注入实值，参与 fits。
5. **模型决策**：
   - 调 `compress(ranges, summary)` → 执行；
   - 调 `decline_compress(reason)` → **显式拒绝**；
   - 两者都没有，且**忙碌排除三条件全中** → **隐式拒绝 0.5 权**：① nudge 注入后 N 轮（默认 2）内无 compress；② 这 N 轮里模型有 assistant 输出且未调任何工具；③ 区间仍满足门。
   - 拒 = 显式（满权）∪ 隐式（0.5 权）。同一区间连续 3 拒 → nudge 降频为每 3 次触发一次。隐式拒绝**只用于降频，不进质量统计**。
6. **执行**：校验区间（active、连续、≥下限、无并发）→ 各块尺寸预检（超 2K 硬顶的块指名给拆分指引，绝不静默零折）→ 写 `blocks/<id>.raw.jsonl`（原文）并 fsync → 摘要落 Block（含 `rawRef`）→ 区间消息标 folded → 写 fold 事件 → nudge 区从后续请求隐藏（只删尾部连续区）。
7. **晋升**：块账叶子 sumTok 总量 > 窗口 × 0.15 时，最老 tier-1 块群折 tier-2（1/4），tier-3 同理（1/3）。父块写 `children`，子块写 `promotedInto`，写 `promote` 事件；**晋升不写新 raw**，父块 decompress 递归展开子块 raw。

> → test: `pipeline.test.mjs` — ①nudge→abort→重发→前缀分歧 = 0；②隐式拒绝忙碌排除：调别的工具 → 0；沉默 N 轮 → 0.5；③紧急路径显式 decline → 不压缩、硬截断兜底；④超限块错误含块号与原因；⑤raw 写入失败 → fold 事件不落账；⑥晋升后父块 decompress 递归展开，原文与 tier-1 一致。

---

## 7. 与 DSH 的集成形状

**工具面**：`compress / decline_compress / decompress / search_context / wj_status / wj_report`。

- `decompress(blockId, mode)`：从 `blocks/<id>.raw.jsonl` 取原文；`context` 模式**尾部追加 tool result**（绝不插回原位），`file` 模式落文件。
- `search_context(query)`：搜 **Block.summary + topics**（块粒度）；需要原文时用 `decompress` 精确取。**不做**原文全量 grep、不做倒排索引。

**patch 写法（修正 #20）**：

~~~yaml
# wanjuan/dsh.bundle.patch.yml  (against DSH <version>)
# 注意：inject 是整列表替换，必须从宿主当前版本导出全量后再追加
- id: preset-standard
  inject: [<宿主当前全部 inject 项...>, wanjuanCompactionPolicy]
- id: compaction-basic
  config: { auto: false }
- id: wanjuan-native
  name: wanjuan
- id: wanjuan-gate
  name: wanjuan/dsh-gate
- id: llm-deepseek
  config:
    retryPolicy:
      mode: normal
      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE]
~~~

**宿主依赖与降级契约**（拿不到时降级 + 可观测）：

| 依赖 | 用途 | 降级路径 | 可观测 |
|---|---|---|---|
| 请求前 messages 快照 | 指纹对账 | 用 ledger 末条 msg hash 对比 | `degraded: fingerprint-hash` |
| 响应 usage | k̂、miss 归因 | missKind = `unattributed`，不更新 k̂ | `degraded: no-usage` |
| abort 事件 | abort 类归因 | 30s 启发式 | `degraded: abort-heuristic` |
| 上次 wire 字节 | seam 探针 | 账本消息 hash 粗定位 | `degraded: seam-coarse` |
| call config | sideLane 标记 | 尾部 marker 兜底 | `degraded: sidelane-marker` |
| 模型表 | 窗口预算 | 128K + warn | `degraded: unknown-model` |
| offload 事件 | 图像重估 | 下轮全量重估 | `degraded: offload-blind` |
| content-id | 媒体身份 | MEDIA REFS 原样保留 + hash 告警 | `degraded: media-hash` |
| per-route 配置 | render 开关 | 默认开，切换时预告全量重放 | `degraded: render-default` |

**降级率**进月报；周环比 >20% 告警——宿主契约漂移的早期信号。

**数据目录**：`<dshHome>/.wanjuan/`（sessions/ blocks/ logs/ session-config/）。

---

## 8. 验收标准

**功能类**

1. **账平**：随机事件序列 1 万步（含 tier 晋升路径）重放，不变式 1–7 全部成立。
2. **前缀纪律**：nudge 注入/隐藏后其前消息字节分歧 = 0；decompress 为尾部追加；非尾部改写被 reconcile 吸收并归因 `rewrite`。
3. **口径与偏置**：全库仅一个 estimate 函数；k̂ 收敛后 `est_final ≥ 真值 × 1.05`；跨模型 k̂ 互不污染。
4. **side-lane 隔离**：100 条假 title-gen → 主线零污染、零 in-band 外泄。
5. **对账**：宿主吃掉 30% 中史 → 轻指纹失配 → reconcile 重算无 stale block；「换中间 1 条」≤10 轮捕获。
6. **端到端**：真机 ≥500 轮全链路；wj_report 对上宿主 usage。
7. **风暴预算**：10 万事件重放单帧阻塞 <50ms；全量重建不在请求热路径。
8. **结局可见**：工具 cap 必合成 final；文本假 marker 剥除；代际切换后旧引用拒解析并给重建指引。
9. **头寸唯一**：`sum(reservations) + active + nudgeReserve ≤ window`；offload 后该消息估算自动重测。
10. **原文可达**：任何块 `rawRef` 指向存在的 `raw.jsonl`；孤儿 raw 被 reconcile 回收并计数。

**度量类（验收抓手）**

11. **结构不可能 bug 类**：≥8 类（§3.8 归宿表）。
12. **静默 bug 数**：0（所有失败 loud）。
13. **传染性 bug 数**：0（模块失败不跨模块）。
14. **异常 miss 率**（真机一周）：可解释，`unattributed` 占比 <10%，`calibrating` 单列。
15. **单次会话用户可感知故障**：目标 0，接受 ≤1/千会话。
16. **降级率漂移**：周环比 >20% 告警。

---

## 9. 里程碑

| 阶段 | 内容 | 覆盖验收项 | 出口 |
|---|---|---|---|
| **P0 前置**（不阻塞 M1，M3 前必交付） | 哲学文本中文定稿 + 版本号 + BC 英文版→中文重写的 A/B 报告 | — | 定稿文件 + 行为对比报告 |
| M1 观测 | store / ledger(只写不裁) / observe / estimate-core / diagnose-core(只记录不归因) / fingerprint(轻+采样) / requests.jsonl / wj_report | 1(退化)、3、4、11–14 | 只读上线一周，异常 miss 率可信 |
| M2 手动折 | blocks / raw.jsonl / compress / decompress / search / invariants 收敛 | 1(全量)、2、5、10 | 真机手动压缩 10 块、恢复 10 次 |
| M3 自动门 | gate / nudge(尾部+标记) / philosophy(接 P0) / 紧急路径 / decline_compress + 忙碌排除 | 6 | 200 轮全自动不撞窗 |
| M4 分层 | tier-2/3 晋升 + promotedInto 账平 + 谱系 + 递归 decompress | 1(晋升路径)、10(递归) | 模拟 30 天，tier-2 ≥1 次且总量有界 |
| M5 收尾 | gate 入口拆分、设置页、patch(整列表 inject)、README | 7、8、9、15、16 | install_bundle 真机 + 全部验收 |

M1 收窄：哲学、gate、nudge、归因树全不进 M1；归因树拆 `diagnose-core`（M1 只落记录）与 `diagnose-report`（M3 再出归因）。**M1 烂尾也值得**。

上线节奏即 bug 暴露策略：每阶段只让一类 bug 有出现机会，影响面被阶段边界限制。

---

## 10. 风险与开放问题

- **估算误差是万病之源**：贝叶斯先验 + 三段管线是结构解，但 `khatPrior` 需用 BC 历史数据回填，回填前是估计值。已知，接受。
- **哲学漂移**：哲学是活文档，改措辞会改变模型行为。P0 定稿 + 版本化 + 账本记 cfg 事件；不做 BC 那种 Layer 0/1 覆盖体系，先一刀切。
- **与宿主原生压缩的边界**：万卷接管后宿主 `compaction-basic` 必须关（patch auto:false）。宿主升级可能改行为——reconcile 是兜底，不是借口。
- **单写入者假设**：多实例是明确非目标。多实例时第二者检测 lockfile → 只读降级，仍写自己的 requests 与本地 snapshot。
- **伦理边界**：账本折叠的是任务上下文，不是「身份」记忆。记忆归 dsh-get-memory/dsh-remember。

---

## 11. 关键决策记录（ADR）

| ADR | 决策 | 理由 |
|---|---|---|
| ADR-1 | ledger 永不裁剪，裁剪只在 snapshot | 事件溯源语义；#6477 结构上不可能 |
| ADR-2 | 偏置在 k̂ 之后，k̂ 样本只除 est_raw | 否则稳态抵消偏置 |
| ADR-3 | 紧急路径不剥夺拒绝权，硬截断兜底 | 守「模型驱动」目标 |
| ADR-4 | 拒绝 = 显式工具 ∪ 隐式 N 轮（忙碌排除，0.5 权） | 降频有可判定信号，不误伤正常节奏 |
| ADR-5 | nudge 只尾部追加 + 内容标记，hide 只删尾部连续区 | 前缀缓存纪律是硬约束；abort 重发可判定 |
| ADR-6 | decompress 一律尾部追加 | 同 ADR-5 |
| ADR-7 | miss 分「预期内 / 异常」两指标 | 单一命中率掩盖异常 |
| ADR-8 | tier 比率相对本层输入，账平只算叶子 | 消除晋升重复计数 |
| ADR-9 | inject 整列表替换，patch 头注宿主版本 | #20 血泪教训 |
| ADR-10 | search 只搜块粒度，原文靠 decompress | 万轮会话全量 grep 不可行 |
| ADR-11 | k̂ 冷启动贝叶斯先验（m=5），n≥5 纯 observed | 冷启动不裸奔，且先验不吃偏置 |
| ADR-12 | 指纹 = 轻指纹 + 采样对账 + 周全量 | 防「换中间」假阴性 + 理论碰撞 |
| ADR-13 | nudgeReserve 取实际注入值，不做常数上界 | 推荐列表尺寸随候选数增长 |
| ADR-14 | 内核不猜模型意图，只认可观测信号 | §3.9 不确定性三出口 |
| ADR-15 | 不变式 3 硬核 + 4 强断言 | 防不变式膨胀 |
| ADR-16 | 失败 loud + isolated，每模块配 failure test | §13 原则 3 |
| ADR-17 | 单次损失最小化优先于触发频率最小化 | 频率降不到 0，损失可接近 0 |
| ADR-18 | 上线节奏即 bug 暴露策略 | 阶段边界 = 影响面边界 |
| ADR-19 | 原文存 `blocks/<id>.raw.jsonl`，与 ledger 同事务 | v0.2.1 补 decompress 硬矛盾 |
| ADR-20 | 安装/升级：schema.json 双写、patch 头注版本、purge 显式 | §14.1 |
| ADR-21 | 磁盘/权限失败三态机 writable→read-only→halted，不进内存态 | §14.2 |
| ADR-22 | 多实例 lockfile：wx 创建 + 10s 心跳 + 60s stale + 只读降级 | §14.3 |
| ADR-23 | 账本含原文不加密；purge 显式；默认保留无 TTL | §14.4 |
| ADR-24 | 用户可见文案全走 locale，缺失回落英文并 warn | §14.5 |

---

## 12. 不修清单（已知必现 bug 与兜底）

| bug | 为何不修 | 兜底 |
|---|---|---|
| 估算冷启动误差 | 无样本可用 | 贝叶斯先验（ADR-11）+ `calibrating` 单列 |
| marker 剥除漏网 | 模型可发明新格式 | 状态变更只认工具；月报扫异常 marker 计数 |
| 指纹假阴性 | 宿主可能保三点换中间 | 采样对账 + 每周全量（ADR-12） |
| 隐式拒绝误判 | 无法区分「没理」与「忙别的」 | 忙碌排除三条件 + 0.5 权 + 只降频不进质量统计 |
| `unattributed` | 上游盲区 | 分级归因 + 阈值 10% 告警不阻塞 |
| 多实例互踩 | 非目标 | lockfile + pid 心跳 → 只读降级 |
| provider-side miss 根因 | 看不到中继 | 标 `provider-miss` + 嫌疑移交 |
| 模型语义随机性 | 温度 >0 | 哲学版本化 + 每处改动带可证伪假设 |
| 指纹理论碰撞 | 概率极低 | 周全量 reconcile |

> 这一节与 §3.8 同等重要：§3.8 说「修了什么」，这一节说「明确不修什么、如何兜底」。没有这一节的设计稿，默认它假装能修好一切。

---

## 13. bug 最小化原则与六项度量

**五条架构原则**

1. **内核只做确定性的事，不确定性外推**（§3.9）。内核里任何「if 模型可能……」式猜测都是 bug 源。
2. **不变式少而硬**（3 硬核 + 4 强断言）。不变式越多，违反概率越高。
3. **失败默认 loud + isolated**。每模块必须产出可观测记录；失败不传染；每模块配 `*.failure.test.mjs`。
4. **单次损失最小化 > 触发频率最小化**。误压缩→可恢复；误拒绝→下轮再判；误对账→重放幂等；误降级→可观测可回滚。**这是万卷架构最值钱的一点。**
5. **上线节奏即 bug 暴露策略**。任何新机制必须回答「它在哪个里程碑上线，上线前失守的最大后果是什么」，答不出就该推迟。

**六项度量（验收抓手）**

| 指标 | 目标 | 说明 |
|---|---|---|
| 结构不可能 bug 类 | ≥8 类 | §3.8 归宿表 |
| 静默 bug 数 | 0 | 所有失败 loud |
| 传染性 bug 数 | 0 | 模块失败不跨模块 |
| 异常 miss 率（真机一周） | 可解释，unattributed <10% | M1 出口 |
| 单次会话用户可感知故障 | 目标 0，接受 ≤1/千会话 | 现实口径 |
| 降级率漂移 | 周环比 >20% 告警 | 宿主契约漂移预警 |

**总损失公式**（本设计的目标函数，非数学定律）：

~~~text
总损失 = Σ_类别 (缺陷率 × 触发频率 × 单次损失)
~~~

- 缺陷率由代码量与人决定 → 小内核 + failure test 压低；
- 触发频率由环境开放性决定 → 外推 + 降级契约压低，**但降不到 0**；
- 单次损失由隔离与兜底决定 → 原则 3/4 压低，**可接近 0**。

「完美」= 总损失 0，不可达；「最小」= 六项度量达标，可达。万卷追求后者，并在 §12 显式声明前者不可达。

---

## 14. M2/M5 前必须回答的开放问题

### 14.1 首次安装与升级

`.wanjuan/` 初始化流程；schema 版本号记在哪（建议 ledger 首行 `cfg` 事件带 `schemaVersion`）；DSH 升级后 patch 失效检测与提示；卸载流程（默认保留账本，提供 `--purge` 选项）。

### 14.2 L-1 层磁盘/权限失败策略

ledger 写失败（磁盘满/无权限）时：暂停压缩 + 转只读 + 告警，不进入内存态（内存态会破坏事件溯源）。`raw.jsonl` 写失败：fold 事件不落账，操作失败 loud。snapshot 写失败：可忽略（本就是缓存）。

### 14.3 多实例 lockfile 协议

lockfile 路径 `sessions/<sid>/.lock`，内容 `{pid, host, startAt}`。心跳周期 10s，stale 判定 60s。接管流程：检测 stale → 抢锁（原子 rename）→ 原持有者若复活则只读降级。所有动作进 requests.jsonl 的 `degraded: lock-contended`。

### 14.4 隐私与保留策略

ledger 与 raw.jsonl 是否含敏感内容：默认含（原文），文档需注明。会话删除时：提供 `--purge-session` 显式删除 ledger + raw + snapshot；默认保留。单会话总量上限：仅分卷（100MB），不自动删除；总量告警阈值可配。

### 14.5 locale 规范

`locale/zh-CN.yml` 结构：`tools.*`（工具描述）、`report.*`（月报文案）、`errors.*`（错误信息）、`degraded.*`（降级提示）。所有用户可见文案走 locale，禁止硬编码中文。M5 前建立最小集。

---

## 14bis. 开放问题与决议（§14 的答案）

> 本节是 §14 五条开放问题的决议版，挂 ADR-20 ~ ADR-24。未标注「待定」的条目即视为已决，落码按此执行。将来整理时与 §14 合并为一节。

### 14.1 首次安装与升级（ADR-20）

| 步骤 | 动作 | 产物 |
|---|---|---|
| 1 | 启动时检测 `<dshHome>/.wanjuan/` 不存在 | — |
| 2 | 创建 `sessions/ blocks/ logs/ session-config/` 四目录 | 四目录 |
| 3 | 写 `schema.json`：`{ schemaVersion: 1, createdAt, hostVersion }` | schema.json |
| 4 | 每个新会话首行 ledger 写 `cfg` 事件，带 `schemaVersion` | ledger 首行 |
| 5 | 写 `README.txt`，首行明示「账本含原文，敏感会话请用 purge-session」 | README.txt |

- **schemaVersion 双写**：权威源 = `schema.json`；ledger 首行 `cfg` 是兜底。两者不一致时以 `schema.json` 为准并告警。
- **升级检测**：patch 文件头记 `againstVersion: "x.y.z"`。启动时读宿主版本，不等 → `warn` + 提示重跑 `install_bundle`，**不自动改 patch**（#6470 教训：自动改 inject 会丢项）。
- **卸载**：`wanjuan uninstall` 保留 `.wanjuan/`；`wanjuan uninstall --purge` 删除（需二次确认 + 提示先备份）。

### 14.2 L-1 层磁盘/权限失败策略（ADR-21）

三态状态机，状态进 `wj_status` 与 `requests.jsonl` 的 `degraded` 字段。

| 状态 | 触发条件 | 行为 | 恢复路径 |
|---|---|---|---|
| `writable` | 正常 | 全功能 | — |
| `read-only` | ledger 写失败 1 次 | 停止压缩、停止写 ledger；仍可读、可 `wj_report`、可 `decompress` | 用户 `wanjuan resume`，或重启探测写成功自动恢复 |
| `halted` | read-only 下连续 3 次写失败，或 raw 写失败导致 fold 不落账 | 全功能停用，仅 `wj_status` 可用 | 手动修复磁盘后 `wanjuan resume` |

- **不进入内存态**：内存态会破坏事件溯源，宁可只读。
- `snapshot.json` 写失败：只 `warn`，**不改变状态机**（缓存可重建）。
- `raw.jsonl` 写失败：当前 fold 失败 loud（§6 第 6 步），不落 fold 事件，不产生半折状态。

### 14.3 多实例 lockfile 协议（ADR-22）

- **创建**：`open(lockPath, 'wx')`（`O_CREAT|O_EXCL`），内容 `{ pid, host, startAt, heartbeatAt }`。创建失败 = 已存在锁。
- **心跳**：持有者每 10s 更新 `heartbeatAt`（临时文件 + `rename` 原子替换）。
- **stale 判定**：满足任一即 stale —— `now - heartbeatAt > 60s` / `pid` 不存在（同 host）/ `host` 不同且无法探测。
- **抢锁**：stale → `rename` 旧锁到 `lock.stale.<ts>` → 尝试新建；失败则重试。
- **重试**：每 10s 一次，上限 6 次（60s）。超限 → 只读降级，记 `degraded: lock-contended`。
- **只读降级边界**：可读、可 `wj_report`、不压缩、不写 ledger；**仍写本地 `requests.jsonl` 与 `snapshot.json`**（按 `writerId` 隔离，不冲突）。

### 14.4 隐私与保留策略（ADR-23）

- **明文声明**：`README.txt` 首行 + `wanjuan status` 输出均提示「账本与 raw 含原文」。不加密（加密引入密钥管理新 bug，且 BC 无此需求）。
- **purge**：`wanjuan purge-session <sid>` 删除该会话 `ledger.jsonl` + `blocks/*.raw.jsonl` + `snapshot.json` + `requests.jsonl`，二次确认。
- **默认保留**：会话结束不自动删；无 TTL。
- **阈值**：单会话 100MB 分卷（§3.1 已有）；总量 `warn` 阈值默认 5GB（可配 `limits.totalWarnGB`），超过只告警不阻塞。

### 14.5 locale 规范（ADR-24）

最小集结构如下，所有用户可见文案走 locale，禁止硬编码中文。缺失 key 回落英文并 `warn`。

~~~yaml
# locale/zh-CN.yml  (v0.1 最小集)
tools:
  compress: "压缩指定区间为摘要块"
  decline_compress: "拒绝本次压缩建议"
  decompress: "恢复指定块的原文"
  search_context: "按关键词检索块摘要"
  wj_status: "查看万卷当前状态"
  wj_report: "生成使用报告"

report:
  hit_rate: "命中率"
  anomaly_miss_rate: "异常未命中率"
  anomaly_miss_tokens: "异常未命中 token 量"
  unattributed_ratio: "低置信未归因占比"
  calibrating_requests: "校准期请求数"
  degraded_rate: "降级率"

errors:
  block_not_found: "块 {id} 不存在"
  range_invalid: "区间 {range} 无效：{reason}"
  summary_too_large: "块 {id} 摘要 {tok} tok 超 2K 硬顶，请拆分"
  raw_missing: "块 {id} 的原文缺失（rawRef={rawRef}），请运行 reconcile"

degraded:
  unknown-model: "模型窗口未知，按 128K 保守预算"
  no-usage: "未收到 usage，本次不更新 k̂"
  abort-heuristic: "无 abort 事件，按 30s 启发式归因"
  sidelane-marker: "sideLane 经 marker 兜底"
  lock-contended: "多实例锁竞争，进入只读降级"
  fingerprint-hash: "无 messages 快照，用账本末条 hash 对账"
  offload-blind: "无 offload 事件，下轮全量重估"
~~~

- M5 前建立此最小集；新增 key 必须同时进 `zh-CN.yml` 与 `en.yml`，CI 检查 key 对齐。

*本文是设计稿 v0.2.1。落码从 M1 开始，仓库形态照 dsh-model-failover：`D:\work\测试\wanjuan\`（package.json 零依赖 + src/*.mjs + test/*.test.mjs + test/*.failure.test.mjs + dsh.bundle.patch.yml + locale/ + README.md）。*