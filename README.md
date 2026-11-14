# 万卷 (wanjuan)

> 读书破万卷。上下文像卷轴一样一折一折收起来，需要时再展开。

**万卷** 是一个为 LLM 宿主（如 DeepSeek Harness）设计的**上下文压缩内核**。它不依赖任何第三方库，完全通过事件溯源（Event Sourcing）和严格的「前缀纪律」，来解决长对话场景下的窗口爆炸与 KV 缓存失效问题。

## 💡 核心理念：每个 Bug 都有归宿

在长上下文场景中，最大的噩梦不是"截断"，而是"缓存全灭"。万卷直面了宿主环境中的泥泞：

- **拒绝背锅（责任隔离）**：宿主每轮重写 persona 导致缓存失效？万卷的月报会输出「总命中率」和「核心命中率」，精准剥离宿主违约与上游盲区。
- **自我愈合（锚点吸收）**：发现宿主偷偷改了历史？万卷不在历史中重写，而是通过追加 `mut` 事件吸收突变，并在尾部注入锚点说明，让账本真正收敛，告别死循环。
- **绝对容错（断电保护）**：写到一半断电导致账本坏行？万卷跳过坏行并大声告警，绝不让一行错误拖垮整个会话。
- **并发安全（目录隔离）**：多窗口同时聊天？按 Session ID 严格隔离账本，互不干涉。

## 🏗 里程碑现状（M1 → M3.5）

| 里程碑 | 状态 | 内容 |
|---|---|---|
| M1 观测模式 | ✅ | `session/event` 全词汇入账（`user/message` / `assistant/message` / `tool/result`），TokenUsage 驼峰 `miss + cached` 语义对齐 |
| M2 手动折叠 | ✅ | `wj_compress` / `wj_decompress` / `wj_search` / `wj_report` 四工具 |
| M3 自动水位 | ✅ | `turn/end` 时用三段式估算器测水位：≥95% 自动折叠最老消息（保尾 20 条），≥80% 提示模型主动折叠 |
| M3.5 真实接管 | ✅ | 折叠后桥接宿主原生 `ctx.compaction.compactRegion`，把真实会话日志区间替换成摘要节点 |

### M3 的两个关键修正

- **`estimator.estRaw` 不存在**：它是 `estimate()` 返回值的字段，不是方法。水位用 `estFinal`（k̂ 校准 + 5% 偏置）除以 `est.window`。
- **宿主消息 ID 是 UUID**：字典序 ≠ 时间序（实测不单调）。折叠一律走**显式 ids 列表**，绝不传 range 端点——`ledger.recordFold` 与 `compressor.compress` 均已支持。

### M3.5 为什么桥接宿主 compaction，而不是自己改请求

宿主三条瀑布全查证过：

- `agent/pre-step`：只给本轮新进的 `UserMessage[]`，历史不在场；
- `agent/request`：契约明文 **"cannot mutate messages"**，`LlmCallConfig` 只有控制项；
- `llm/stream`：LOOP 请求的 `messages` **深度冻结**（reconstructability 原则：请求必须是会话日志的纯函数）。

唯一合法入口是 `ctx.compaction.compactRegion(startSeq, endSeq, agent)`——成功后真实日志区间替换成一个摘要节点，模型可见、缓存责任归宿主。万卷在账本里记录事件 `seq`（SessionSeq），完成「账本消息 → 真实日志区间」的映射；服务缺失时优雅降级为只折账本。

## 🧰 工具面

| 工具 | 作用 |
|---|---|
| `wj_compress` | 把指定消息折叠为摘要（内置 KEEP/DROP 哲学） |
| `wj_decompress` | 恢复折叠块原文 |
| `wj_search` | 在折叠块中检索 |
| `wj_report` | 磁盘账本报告 + **最近日志环**（水位告警、折叠结果、桥接成败一目了然） |

## 🛠 架构亮点

- **零第三方依赖**：纯原生 Node.js ESM（>= 20）。
- **事件溯源账本**：`msg / mut / fold / evict / unfold / promote`，坏行告警、断电保护、多会话隔离。
- **三段式估算**：`est_raw → × khat → × 1.05 偏置`，引入贝叶斯先验，且绝不污染真实 usage 校准。
- **日志环**：Electron 主进程的 console 在 Windows 下不可见，插件内存保留最近 30 条日志，`wj_report` 直接展示。
- **防弹测试**：138 个自动化测试用例（含大量失败注入），`node --test` 全绿。

## 🚀 跑起来看看

```bash
# 运行测试（预期 138 个用例全绿）
npm test
```

## 📦 作为 DSH 插件接入

包内自带 `dsh.bundle.patch.yml`（`dsh.bundle.patch` 字段声明）。核心配置：

| 配置 | 默认 | 说明 |
|---|---|---|
| `dir` | — | 账本/块存储目录（相对 profile 数据目录，如 `.wanjuan`） |
| `shadowMode` | `false` | `true` 时退回影子模式：折叠只提示、水位引擎关闭 |

## 📜 License

MIT
