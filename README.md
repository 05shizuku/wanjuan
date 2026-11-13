# 万卷（wanjuan）设计文档 v0.3.0（接关节版）

**Amikar和猫羽雫设计的一个上下文压缩管理器。**
日期：2026-11-13 · 状态：已落码（125 用例全绿） · 目标宿主：DeepSeek Harness (DSH)

> 核心顿悟：这套机器是围着「我来判断折什么」转的，但真正决定命中率的，是**前缀纪律**。万卷只握着最远的一环，因此必须接上宿主的关节——**宿主契约、anchor 继承**。

## 1. 设计目标与边界契约

万卷的边界内，一切都有归宿（账本、估算、门、去重）。但边界外的事情决定了核心指标的成绩单。

### 1.1 边界契约（Host Contract）
- **不假设宿主永远不违约**：宿主每轮重写 persona、代理重编号、上游 TTL，万卷拦不住。
- **责任隔离**：月报必须产出「总命中率」与「万卷核心命中率（剥离宿主/上游责任）」，把冤案切割出去。
- **反向验收**：每月（或每次升级）用探针对宿主跑一遍 Diff，谁破约谁修，绝不替宿主背锅。

### 1.2 核心目标（不变）
1. **有界上下文**：总上下文在窗口内震荡而非增长。
2. **只压增量**：每轮只压上次压缩以来新增的内容。
3. **模型驱动**：压什么由模型按任务状态决定，有拒绝权。
4. **可恢复**：折叠的原文存 `raw.jsonl`，随时 `search` 与 `decompress`。
5. **缓存友好**：append-only 布局保证 KV 前缀不失效。

---

## 2. 承重设计与哲学注入

### 2.1 信息留存与折叠规则
- **tier-1 ~1/8**（工具主导 ~1/24）→ **tier-2 ~1/4** → **tier-3 ~1/3**。比率相对本层输入。
- 摘要单块中位 185 tok，硬顶 2K。

### 2.2 哲学文本（P0 中文实战版）
绝不泛泛而谈，直接唤醒模型“丢垃圾、留骨架”的本能：

**【DROP 必须丢弃】**
- 冗长的工具执行日志（如 `npm run build` 成功输出，仅保留最后 3 行；有错保留堆栈）。
- 重复读取同一文件的过程（只保留最后一次读取结果）。
- 无意义的对话过程（如“继续”、“好的”）。
- 已被推翻的探索路径（丢弃试错，仅留“A 方案不可行”）。

**【KEEP 必须保留】**
- 带行号的具体路径与函数签名（如 `src/dsh.mjs:42`）。
- 精确的错误字符串（如 `ERR_MODULE_NOT_FOUND`）。
- 多轮排查得出的结论（如“宿主注入了空 system 消息”）。
- 工具调用的最终参数（只留调用了什么，不留执行过程）。

**【优先级】**：当前目标 > 决策结论 > 核心代码结构 > 精确错误 > 历史教训。

---

## 3. 核心机制与 Bug 归宿

### 3.1 估算器（k̂ 校准与污染修复）
- **唯一口径原则**：`estimate(request)` 是唯一估算函数，作用域 `(provider, model)`。
- **三段管线**：`est_raw` → `× khat` → `× 1.05` 偏置。样本仅除 `est_raw`。
- **⚠️ 修复：k̂ 不被注入污染**。请求发出前，计算一次原生估算 `nativeEst`（不含 nudge/锚点）。收到 usage 后，用 `usage / nativeEst` 更新 k̂，避免因 nudge 撑大分母导致 k̂ 永远偏小。
- **两段式 k̂**：`n<5` 用贝叶斯先验兜底，`n≥5` 用纯 observed 无偏接管。

### 3.2 存储与账本（事件溯源）
- `ledger.jsonl` 只追加、永不裁剪。裁剪只作用 `snapshot.json`（永远从最旧丢）。
- **⚠️ 修复：hashMsg 包含内容**。比对消息是否变异时，哈希必须包含 `{id, bytes, content}`，否则宿主原地改写文本无法察觉。
- **⚠️ 修复：正常生长 vs 宿主重写**。对账本里没见过的消息 id 视为「正常生长（growth）」，归 `new`；只有已知 id 的 `content/bytes` 发生改变，才归 `content-mismatch`（宿主违约）。

### 3.3 增速门与受控提示（Nudge）
- 增长 `< 50K` 静默；`85%~95%` 门限降至 `0.45×`；`≥95%` 紧急路径。
- **拒绝降频**：同一区间连续被拒 3 次，nudge 降频为每 3 轮一次。模型仍可调用 `decline_compress` 显式拒绝。
- **⚠️ 修复：冷启动静默**。首次请求 `lastFoldEst` 初始化为当前原生估算值（growth=0），防止首次请求就弹压缩建议。

### 3.4 对账与 M1.5 锚点吸收（Anchor 迁移）
- **轻指纹每轮**（条数+首末id+总字节）+ **采样对账**（每 10 轮或检测到重写时抽 3 条比对）。
- **锚点吸收**：如果探针发现宿主重写了已知消息（`content-mismatch`），万卷不重写历史，而是在尾部追加一条 `ephemeral: true` 的锚点说明（“[万卷锚点说明] 宿主在历史 X 处修改了上下文，请以此为准”）。该锚点不进账本，仅本轮回传，从而保住前文缓存。

### 3.5 诊断与责任隔离
- 每次请求落 `requests.jsonl`，两层分类（预期内/异常）。
- **归因隔离**：
  - `host-rewrite` → 宿主违约 (Host)
  - `ttl` / `provider-miss` → 上游盲区 (Upstream)
  - `seam` / `abort` → 万卷自身 (Wanjuan)
- 月报输出「核心命中率」：剔除宿主和上游导致的未命中，只看万卷职责范围内的真实表现。

---

## 4. 数据结构核心账目

```ts
type Ev =
  | { k: "msg";    id: string; at: number; bytes: number; tok: number; cls: "text"|"tool"|"sys"|"dev"; gen: number; content?: string; }
  | { k: "fold";   block: string; range: [string, string]; srcTok: number; sumTok: number; tier: 1|2|3; rawRef: string; }
  | { k: "evict";  ids: string[]; why: "reconcile"|"host-compact"; }
  | { k: "promote"; parent: string; children: string[]; srcTok: number; sumTok: number; tier: 2|3; }
  | { k: "cfg";    patch: object; by: string; }

type Block = {
  id: string;            // b1, b2...
  tier: 1|2|3;
  range: [string,string];
  srcTok: number;        // 原始输入 token
  sumTok: number;        // 摘要自身 token
  summary: string;       // ≤2K 硬顶
  topics: string[];
  children?: string[];   // tier-2/3 谱系
  promotedInto?: string; // 有值即非叶子，不参与账平
  rawRef: string;        // 指向 blocks/<id>.raw.jsonl
};