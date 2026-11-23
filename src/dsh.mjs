import { tmpdir } from 'node:os';
// src/dsh.mjs
// 万卷 DSH 插件。2026-11-14 真机契约最终修正：
//  - 不注册 ctx.on('llm/stream')。
//  - 工具定义使用 parameters 字段。
//  - render 签名修正为 (_args, value) => value，防止宿主把 args 误当返回值处理导致 content.some 崩溃。
import { readFileSync, writeFileSync, appendFileSync, statSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createWanjuan, PHILOSOPHY_KEEP_DROP } from './index.mjs';
import { buildReport } from './report.mjs';
import { estimateTok } from './tokenizer.mjs';

export const name = 'wanjuan';
// compaction：M3.5 真实上下文接管必需。宿主访问控制要求先声明 inject
// （2026-11-14 真机实测：直接属性访问抛 "cannot get property without inject"）。
// 若 profile 未挂 compaction 实现导致加载失败，需在插件管理里启用原生 compaction-basic。
export const inject = ['tools', 'compaction', 'llm']; // v0.7.7 P2-12(D)：裁剪全程未使用的 connection/tokenMeter/webServer（缩小访问面）

let _seq = 0;
const _boot = Date.now().toString(36); // v0.7.7 P2-3(D)：合成 id 带启动戳——重启后不再与历史账本碰撞
function nextMsgId() { return `m${_boot}-${++_seq}`; }

export function normalizeUsage(usage) { // v0.7.7：导出供形态表测试
  if (!usage) return null;

  // v0.7.7 P1-1(D)：按已知形态显式分支，绝不猜加法——OpenAI 的 prompt_tokens 是总数
  // （cached 是子集，相加即双计），Anthropic 的 input_tokens 不含 cache_read。
  if (usage.inputTokens !== undefined) {
    // 宿主契约：inputTokens = miss，cacheReadTokens = cached
    const cached = usage.cacheReadTokens ?? 0;
    return { input: usage.inputTokens + cached, cached };
  }
  if (usage.prompt_tokens !== undefined) {
    // OpenAI 总数口径
    const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? usage.cached ?? 0;
    return { input: usage.prompt_tokens, cached };
  }
  if (usage.input_tokens !== undefined) {
    // Anthropic/中继：input_tokens 不含 cache_read
    const cached = usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cached_tokens ?? usage.cached ?? 0;
    return { input: usage.input_tokens + cached, cached };
  }
  if (usage.input !== undefined) {
    const cached = usage.cacheReadTokens ?? usage.cached_tokens ?? usage.cached ?? 0;
    return { input: usage.input + (cached || 0), cached };
  }
  return { input: 0, cached: 0, degraded: 'usage-shape-unknown' };
}

function recordOne(wj, message, at, seq) {
  if (!message) return;
  const id = message.id ?? nextMsgId();
  // M4：宿主突变吸收——同一 id 重复投递且内容变化时走 mut 事件（追加，绝不改写历史）
  const existing = wj.ledger.messages.get(id);
  if (existing && existing.status === 'active' && message.content !== undefined) {
    let oldC = null, newC = null;
    try { oldC = JSON.stringify(existing.ev.content ?? null); newC = JSON.stringify(message.content ?? null); } catch {}
    if (oldC !== null && newC !== null && oldC !== newC) {
      try {
        wj.ledger.recordMut({ id, at: at ?? Date.now(), bytes: Buffer.byteLength(newC), content: message.content, tok: estimateTok(message.content) });
        return;
      } catch {}
    }
  }
  wj.ledger.recordMsg({
    id,
    tok: message.tok ?? estimateTok(message.content),
    content: message.content,
    role: message.role,
    at: at ?? message.at ?? 0,
    seq,  // M3.5：宿主会话日志序号，供 compactRegion 做区间映射
  });
}

export class WanjuanPlugin {
  constructor({ config = {} } = {}) {
    this.config = config;
    this.dir = config.dir;
    this.shadowMode = !!config.shadowMode;
    this.logToFile = config.logToFile !== false; // v0.6.4：日志默认落盘（256KB 轮转），便于事后审计
    this._sessions = new Map();
    this._legacyAdopted = false; // 多会话隔离：首个会话收编根目录旧账本（升级无感），后续会话独立目录
    this._currentSessionId = null; // 最近活跃会话（工具与桥接状态的归属依据）
    // 日志环：Electron 主进程的 console 在 Windows 双击启动时不可见，
    // 文件日志也不收插件的 console 输出——所以内存留一份最近 30 条，wj_report 展示。
    this.logs = [];
    this._pendingNudge = new Map();   // sessionId -> { message, turn, candidateIds }（M5.2）
    this._injectedTurns = new Map();  // sessionId -> Set<turn>（同 turn 只注一次）
    this._lastRealInput = new Map();  // sessionId -> { input, t }（最近一次真实 usage 观测，水位止血用）
    this._lastDivergeLog = new Map(); // sessionId -> t（背离日志节流，10 分钟/会话）
    this._sessionBaseline = new Map(); // sessionId -> { baseline, t }（v0.7 附加量模型：结构性开销）
this._hostSessions = new Map(); // v0.7.7 P1-4(D)：sessionId→Session——单槽 _lastHostSession 在多会话事件交错下会把 A 的 seq 区间送进 B 的表面
this._lastUsageRecord = new Map(); // v0.7.7 P1-8(D)：会话最近一次 provider/model 记录（turn/end 免全量读盘）
  }

  pushLog(level, msg) {
    // v0.6.26：带上当前会话前缀（前 8 位），多会话下日志不再跨会话混流
    // 宿主会话 ID 形如 session-xxxx——剔除前缀再取 8 位，否则前缀恒为 [session-]
    const sid = this._currentSessionId ? String(this._currentSessionId).replace('session-', '').slice(0, 8) : 'root';
    const prefixedMsg = `[${sid}] ${msg}`;
    this.logs.push({ t: Date.now(), level, msg: prefixedMsg });
    if (this.logs.length > 30) this.logs.shift();
    // 原 console 行为保留：终端启动时仍然实时可见
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    try { fn(`[wanjuan] ${prefixedMsg}`); } catch {}
    this._appendLogFile(level, prefixedMsg);
  }

  // v0.6.4：日志落盘到 <数据目录>/wanjuan.log.jsonl，超 256KB 轮转保留最后 100 行
  _appendLogFile(level, msg) {
    if (!this.logToFile || !this.dir) return;
    try {
      const path = join(this.dir, 'wanjuan.log.jsonl');
      const line = JSON.stringify({ t: Date.now(), level, msg: String(msg) }) + '\n';
      try {
        if (statSync(path).size > 262144) {
          const tail = readFileSync(path, 'utf8').trim().split('\n').slice(-100);
          writeFileSync(path, tail.join('\n') + '\n' + line, 'utf8');
          return;
        }
      } catch {}
      appendFileSync(path, line, 'utf8');
    } catch {}
  }

  getOrCreate(sessionId) {
    const key = String(sessionId ?? 'default');
    if (!this._sessions.has(key)) {
      // v0.6.17 多会话隔离：每会话独立账本目录（sessions/<sid>/）。
      // 首个会话收编根目录旧账本（升级无感，历史延续）；后续会话完全隔离，
      // 折叠选择不再跨会话混选，桥接 seq 恒为本会话日志位次。
      // v0.7.5 P2-2：收编归属持久化——根账本的 owner sid 记入 owner.json，此后该 sid
      // 永远映射根目录（防第二会话诞生后根账本变孤儿：块检索/raw/baseline 全部不可达）
      let ownerSid = null;
      let ownerCorrupt = false;
      try { ownerSid = JSON.parse(readFileSync(join(this.dir, 'owner.json'), 'utf8')).sid ?? null; } catch { ownerCorrupt = existsSync(join(this.dir, 'owner.json')); }
      if (ownerCorrupt) console.warn('[wanjuan] owner.json 解析失败（疑似写入中断），已拒绝根目录收编，会话走独立目录'); // v0.7.6 P2(C1)
      const legacyReady = ownerSid !== null ? key === ownerSid : (!ownerCorrupt && this._legacyAdopted !== true && !existsSync(join(this.dir, 'sessions')));
      const sid = key.replace(/[^\w.-]/g, '_').slice(0, 80) || 'default';
      const sessionDir = legacyReady ? this.dir : (ownerSid === key ? this.dir : join(this.dir, 'sessions', sid));
      if (legacyReady) {
        this._legacyAdopted = true;
        // v0.7.6 P2(C2)：tmp+rename 原子写（与 host-bridge.json 同款）
        try {
          const otmp = join(this.dir, `.owner-${Date.now()}.tmp`);
          writeFileSync(otmp, JSON.stringify({ sid: key, at: Date.now() }), 'utf8');
          renameSync(otmp, join(this.dir, 'owner.json'));
        } catch {}
      }
      const wj = createWanjuan({ dir: sessionDir, compactionThreshold: this.config?.compactionThreshold });
      this._loadLearnedInto(wj); // 模型学习是全局知识，注入每个新会话
      let bridgeStatus = {};
      try { bridgeStatus = JSON.parse(readFileSync(join(sessionDir, 'host-bridge.json'), 'utf8')); } catch {}
      this._sessions.set(key, { wj, sid: sessionDir, bridgeStatus });
    }
    return this._sessions.get(key);
  }

  // 模型学习是全局知识（不属于会话）：从根目录注入会话 estimator
  _loadLearnedInto(wj) {
    try {
      const disk = JSON.parse(readFileSync(join(this.dir, 'models.learned.json'), 'utf8'));
      for (const [provider, models] of Object.entries(disk)) {
        const pp = (wj.estimator.models[provider] ??= {});
        Object.assign(pp, models);
      }
    } catch {}
  }

  // 工具与桥接状态的归属：最近活跃会话（单线程事件循环下与调用方一致）
  _currentWj() {
    return this.getOrCreate(this._currentSessionId ?? 'default').wj;
  }

  // v0.7.7 P0-2(D)+P1-7(D)：块锚统一提取——先扫折叠消息的 seq（自压缩后恒空：折叠消息的
  // msg 事件已被丢弃），回退 block.seqSpan（_compactionEvents 在压缩时刻写入的唯一幸存锚），
  // 再无才判无锚。此前长会话自压缩后全部存量块永久失桥（M3.5 核心承诺失效）。
  // 极值用单趟循环（P1-3：20 万元素 Math.min(...a) 抛 RangeError）。
  blockSeqAnchors(wj, block) {
    let lo = Infinity, hi = -Infinity;
    for (const m of wj.ledger.messages.values()) {
      if (m.status !== 'folded' || m.blockId !== block.id || typeof m.ev.seq !== 'number') continue;
      if (m.ev.seq < lo) lo = m.ev.seq;
      if (m.ev.seq > hi) hi = m.ev.seq;
    }
    if (lo !== Infinity) return [lo, hi];
    if (Array.isArray(block.seqSpan) && Number.isFinite(block.seqSpan[0]) && Number.isFinite(block.seqSpan[1])) return [block.seqSpan[0], block.seqSpan[1]];
    return null;
  }

  async _toolCompress(args) {
    if (this.shadowMode) {
      return '影子模式：只提示，不真的折叠。把 shadowMode 设为 false 才生效。';
    }
    // v0.7.5 P2-1：入口快照会话指针——桥接 await 期间实时指针可能切换
    const sid = this._currentSessionId ?? 'default';
    const hostSession = this._hostSessions?.get(sid) ?? this._lastHostSession; // v0.7.7 P1-4(D)：按入口会话取
    const wj = this.getOrCreate(sid).wj;
    const before = new Set(wj.ledger.listBlocks().map((b) => b.id));
    wj.compressor.compress({
      ...args,
      // 手动路径也补 sumTok（此前只有自动折叠路径传了）
      sumTok: estimateTok(args.summary ?? ''), // P0-8 + P2：单消息场景 estRaw ≡ tok，直用 estimateTok 不触发 unknown-model degrade
    });
    // M3.5：手动折叠后同样桥接宿主原生压缩（1M 大窗口下自然折叠稀少，
    // 手动路径同时是 M3.5 的实时验证通路）。
    const newBlock = wj.ledger.listBlocks().find((b) => !before.has(b.id));
    if (newBlock && typeof this.tryHostCompaction === 'function') {
      // v0.7.7 P0-2(D)：统一锚提取（消息扫描 → seqSpan 回退）——自压缩后仍可桥接
      const span = this.blockSeqAnchors(wj, newBlock);
      if (span) {
        const p = this.tryHostCompaction(hostSession, span[0], span[1], newBlock.id, sid);
        if (p) await p; // 等宿主压缩完成再返回——工具结果消息必须落在压缩之后，表面稳定性才成立
      }
    }
    // M5.2：压缩成功 → 消费该会话的 pending nudge（模型已响应）
    try {
      // v0.7.5 P2-1：用入口快照 sid（await 期间实时指针可能切换）
      const pending = this._pendingNudge.get(sid);
      if (pending && newBlock && pending.candidateIds.length > 0) {
        // v0.7.6 P2(C2)：用折叠后账本的真实 id 集——range 折叠时 args.ids 为空，旧判定恒 miss。
        const foldedIds = new Set();
        for (const m of wj.ledger.messages.values()) {
          if (m.status === 'folded' && m.blockId === newBlock.id) foldedIds.add(m.ev.id);
        }
        const hit = pending.candidateIds.some((id) => foldedIds.has(id));
        if (hit) {
          // v0.7.7 P0-1(D)：逐候选清账——并集 key 清不掉单候选的 reject 状态
          wj.nudge.recordAcceptCandidates(pending.candidates ?? []);
          this.pushLog('log', `[nudge] 接受：折叠覆盖候选（${pending.candidates?.length ?? 0} 个），rangeStates 已按候选清账`);
        }
      }
      this._pendingNudge.delete(sid);
    } catch (e) {
      this.pushLog('warn', `[nudge] accept 记账失败：${e.message}`);
    }
    return '✅ 已折叠';
  }

  // v0.6.2 补桥：对「账本已折、宿主未折」的历史块补发 compactRegion，
  // 修复审查指出的「白折」错位（水位低估、真实上下文仍堆满老消息）。
  async _toolReconcile() {
    if (this.shadowMode) return '影子模式：不执行补桥。';
    if (!this.tryHostCompaction || !this.dir) return '桥接未初始化（config.dir 未设置？）。';
    if (!this._lastHostSession) return '跳过（尚无宿主 session 引用，等首个会话事件后可用）。';
    // v0.7.5 P1-1：入口快照会话指针——循环 await（桥接最长 180s）期间实时指针可能切到
    // 其他会话，把 A 的 seq 区间错压到 B 的 surface、把 A 的块状态写进 B 的 host-bridge.json
    const entrySid = this._currentSessionId ?? 'default';
    const hostSession = this._hostSessions?.get(entrySid) ?? this._lastHostSession; // v0.7.7 P1-4(D)：按入口会话取
    const srec = this.getOrCreate(entrySid);
    const wj = srec.wj;
    const bridgeStatus = srec.bridgeStatus ?? {};
    const out = [];
    // v0.6.16 P1-2：清理超 24h 的 ok 记录，防 host-bridge.json 无限膨胀。
    // 只清 ok：其重试落在「not found → skip」上，代价为零；skip 是终态，清了会重烧 LLM。
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      let pruned = false;
      for (const [bid, brec] of Object.entries(bridgeStatus)) {
        if ((brec.status === 'ok') && (brec.at ?? 0) < cutoff) { delete bridgeStatus[bid]; pruned = true; }
      }
      if (pruned) {
        srec.bridgeStatus = bridgeStatus;
        const bp = join(srec.sid, 'host-bridge.json');
        const tp = bp + '.tmp';
        writeFileSync(tp, JSON.stringify(bridgeStatus, null, 2), 'utf8');
        renameSync(tp, bp);
      }
    } catch {}
    for (const b of wj.ledger.listBlocks()) {
      // v0.7.7 P0-2(D)：统一锚提取——自压缩后折叠消息不在账本，回退 block.seqSpan；
      // 此前「无 seq 锚」让长会话全部存量块永久失桥（核心承诺失效）。
      const span = this.blockSeqAnchors(wj, b);
      if (!span) { out.push(`${b.id}: 跳过（无 seq 锚，宿主无法定位区间）`); continue; }
      const [start, end] = span;
      const st0 = bridgeStatus?.[b.id]?.status;
      if (st0 === 'ok') { out.push(`${b.id}: 已打通（seq ${start}→${end}），跳过`); continue; }
      if (st0 === 'skip') { out.push(`${b.id}: 已终态（${(bridgeStatus[b.id]?.error ?? '').slice(0, 300)}），跳过`); continue; }
      if (st0 === 'pending') {
        // v0.6.16 P0-2：pending 超 3 分钟即僵尸（崩溃/挂起遗留）——按 failed 重试，不再永久跳过。
        // 同进程内 in-flight 的桥接 at 是新鲜的，仍受保护。
        const stAt = bridgeStatus?.[b.id]?.at ?? 0;
        if (Date.now() - stAt < 3 * 60 * 1000) { out.push(`${b.id}: 桥接进行中（${Math.round((Date.now() - stAt) / 1000)}s），跳过`); continue; }
        out.push(`${b.id}: pending 超时（僵尸），按 failed 重试`);
      }
      if (st0 === 'failed') {
        // v0.6.24 修复A：failed 冷却 30 分钟——超窗口场景（如 1M 切 256K 后全量折叠，
        // 宿主摘要必然 context length exceeded）会形成「每 10 分钟重试→失败→再标记」
        // 的死循环（日志刷屏 + 空 LLM 调用）。冷却期内跳过，30 分钟后允许重试一次。
        const fAt = bridgeStatus?.[b.id]?.at ?? 0;
        if (Date.now() - fAt < 30 * 60 * 1000) {
          out.push(`${b.id}: 上次桥接失败（${Math.round((Date.now() - fAt) / 60000)} 分钟前），冷却中跳过`);
          continue;
        }
        out.push(`${b.id}: failed 冷却结束，重试`);
      }
      const p = this.tryHostCompaction(hostSession, start, end, b.id, entrySid); // v0.7.5 P1-1：快照
      if (p) await p;
      // v0.6.21 P0：读 srec.bridgeStatus（markBridge 原地修改该记录）——
      // this._bridgeStatus 在 await 期间可能已被其他会话的事件切换覆盖
      const st = srec.bridgeStatus?.[b.id]?.status ?? '未知';
      const err = srec.bridgeStatus?.[b.id]?.error;
      // v0.6.25：截断放宽到 300，宿主拒绝原因（如 context length exceeded 的具体数值）可直接定位
      out.push(`${b.id}: seq ${start}→${end} → ${st}${err ? '（' + err.slice(0, 300) + '）' : ''}`);
    }
    return out.length ? out.join('\n') : '没有需要补桥的块。';
  }
}

function buildTools(plugin) {
  const makeTool = (name, description, properties, required, rawHandler) => {
    const wrappedHandler = async (args) => {
      try {
        const result = await rawHandler(args);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { 
          isError: true, 
          content: [{ type: 'text', text: `执行失败: ${err.message}` }] 
        };
      }
    };

    return {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        required,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'array' },
            isError: { type: 'boolean' }
          },
          required: ['content']
        },
        render: (_args, value) =>
          Array.isArray(value) ? value :
          Array.isArray(value?.content) ? value.content :
          [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      handler: wrappedHandler,
      execute: wrappedHandler,
    };
  };

  return [
    makeTool(
      'wj_compress',
      `${PHILOSOPHY_KEEP_DROP}\n把指定区间的消息折叠为摘要。summary 必须丢弃可恢复细节，只保留因果与结论。`,
      {
        range: { type: 'array', items: { type: 'string' }, description: '要折叠的消息 ID 区间（与 ids 二选一）' },
        ids: { type: 'array', items: { type: 'string' }, description: '显式消息 ID 集合（UUID 主机推荐，优先于 range）' },
        summary: { type: 'string', description: '摘要内容' },
      },
      ['summary'],
      (args) => plugin._toolCompress(args)
    ),
    makeTool(
      'wj_reconcile',
      '补桥：对账本已折叠但宿主原生压缩未打通的历史块，补发 compactRegion。修复「账本折了、真实上下文还在」的错位。',
      {},
      [],
      () => plugin._toolReconcile()
    ),
    makeTool(
      'wj_decompress',
      '把已折叠的块恢复为原文。',
      {
        blockId: { type: 'string', description: '块 ID' },
        mode: { type: 'string', description: '恢复模式' },
      },
      ['blockId'],
      (args) => {
        const wj = plugin._currentWj(); // 模型不知道 sessionId，跟随当前活跃会话
        return wj.restorer.decompress(args.blockId, args.mode ?? 'context');
      }
    ),
    makeTool(
      'wj_search',
      '在折叠块中检索（注意：仅支持子串/连续短语匹配，暂不支持多词分词 AND 检索；检索范围为块摘要与主题，原文请用 wj_decompress）。',
      { query: { type: 'string', description: '检索词' } },
      ['query'],
      (args) => {
        const wj = plugin._currentWj(); // 模型不知道 sessionId，跟随当前活跃会话
        return wj.restorer.search(args.query);
      }
    ),
    makeTool(
      'wj_unfold',
      '把已折叠块的全部消息恢复为活跃（纯账本记账修复：不投递原文进上下文）。用于误折叠纠正；需要看原文细节请用 wj_decompress。',
      { blockId: { type: 'string', description: '要恢复的块 ID（如 b1）' } },
      ['blockId'],
      (args) => {
        const wj = plugin._currentWj();
        // 不调 getBlock：unfold 的 _apply 会删除块记录（BlockError），消息计数天然幂等
        let count = 0;
        for (const m of wj.ledger.messages.values()) {
          if (m.status === 'folded' && m.blockId === args.blockId) count += 1;
        }
        if (count === 0) return `块 ${args.blockId} 当前没有折叠中的消息（可能已恢复过或不存在）`;
        wj.ledger.recordUnfold({ block: args.blockId, why: 'repair' });
        return `✅ 已恢复 ${count} 条消息为活跃（纯账本记账：原文未投递上下文；水位判定走真实 input，不会因此误折叠）`;
      }
    ),
    makeTool(
      'wj_report',
      '生成缓存命中率与责任归属报告。可选 logTail 深读落盘日志尾部（事故现场审计）。',
      { logTail: { type: 'number', description: '额外读取 wanjuan.log.jsonl 尾部行数（≤200，缺省 0 只看内存日志环）' } },
      [],
      (args) => {
        const wj = plugin._currentWj(); // v0.6.19：跟随当前活跃会话（与 wj_compress 一致）
        if (!wj || !wj.diagnoser || typeof wj.diagnoser.readAll !== 'function') {
          throw new Error('诊断器尚未初始化');
        }
        // Diagnoser.size() 在 diagnose.mjs 里就是 readAll().length——每次从磁盘
        // requests.jsonl 现数，并非内存态。以磁盘为唯一数据源，报总数、时间跨度，
        // 并在用量字段全为零时给出校准提示。
        let rs;
        try {
          rs = wj.diagnoser.readAll();
        } catch (e) {
          return `万卷报告：requests.jsonl 读取失败：${e.message}`;
        }
        const total = rs.length;
        let span = '';
        if (total > 0) {
          const fmt = (t) => (typeof t === 'number' ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '?');
          span = `，时间跨度 ${fmt(rs[0].t)} → ${fmt(rs[total - 1].t)}`;
        }
        const zeroUsage = rs.filter((r) => !(r.input > 0)).length;
        const warn = zeroUsage === total && total > 0 ? '；⚠️ 全部记录 input=0，用量钩子还没取到真实 token 数（M1 校准未接通）' : '';
        // 日志环：附最近 10 条，聊天里直接看水位/折叠/桥接动态
        let logTail = '';
        const logs = Array.isArray(plugin.logs) ? plugin.logs.slice(-10) : [];
        if (logs.length > 0) {
          const fmtT = (t) => (typeof t === 'number' ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '?');
          logTail = '\n最近日志：\n' + logs.map((l) => `  [${fmtT(l.t)}] ${l.level} ${l.msg}`).join('\n');
        }
        // v0.6.5：可选深读落盘日志（事故现场不重启也能看）
        let deepLog = '';
        const want = Math.min(Number(args?.logTail) || 0, 200);
        if (want > 0 && plugin.dir) {
          try {
            const lp = join(plugin.dir, 'wanjuan.log.jsonl');
            if (existsSync(lp)) {
              const fmtD = (t) => (typeof t === 'number' ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '?');
              const lines = readFileSync(lp, 'utf8').trim().split('\n').slice(-want);
              deepLog = '\n落盘日志尾部：\n' + lines.map((l) => {
                try { const o = JSON.parse(l); return `  [${fmtD(o.t)}] ${o.level} ${o.msg}`; } catch { return `  ${String(l).slice(0, 120)}`; }
              }).join('\n');
            } else deepLog = '\n落盘日志：尚无文件';
          } catch (e) { deepLog = `\n落盘日志读取失败：${e.message}`; }
        }
        // v0.6.19：月报接线（buildReport 终于上生产——命中率/责任归属/块统计）
        let monthly = '';
        try {
          monthly = '\r\n\r\n' + buildReport({ dir: wj.dir, ledger: wj.ledger, diagnoser: wj.diagnoser });
        } catch (e) { monthly = '\r\n\r\n月报生成失败：' + e.message; }
        return `万卷报告：requests.jsonl 累计 ${total} 条${span}${warn}。${logTail}${deepLog}${monthly}`;
      }
    ),
  ];
}

export function apply(ctx, config = {}) {
  // v0.7.6 P1(C2)：幂等 apply——ctx.on 是累加语义，重复 apply 会双监听：双 Store 交错追加、
  // 同批消息折成双块、nudge 每 turn 双注入。
  if (ctx._wj) {
    try { ctx._wj.pushLog('warn', '重复 apply：已存在活跃实例，直接复用（如需重载请重启宿主）'); } catch {}
    return ctx._wj;
  }
  // v0.7.7 P2-4(D)：config.dir 校验——缺失时 join(undefined) 会在每个事件上炸 catch，
  // 且 catch 块自身再炸一次（existsSync(join(...))），冒泡成每事件一条 warn。
  if (!config || typeof config.dir !== 'string' || !config.dir.trim()) {
    console.warn('[wanjuan] ⚠️ config.dir 缺失或非法——进入影子模式（只记账不折叠，数据写系统临时目录）');
    config = { ...config, dir: join(tmpdir(), 'wanjuan-shadow-noconfig'), shadowMode: true };
  }
  const plugin = new WanjuanPlugin({ config });
  ctx._wj = plugin;

  // M4.5：启动环境探针——压缩服务缺失时大声告知，避免静默待机
  try {
    const hasCompaction = ctx.compaction && typeof ctx.compaction.compactRegion === 'function';
    if (!hasCompaction) {
      plugin.pushLog('warn', [
        '══════════════════════════════════════════════════════════',
        '⚠️ [万卷] 未检测到宿主 compaction 服务！',
        '   影响：记账与折叠正常，但真实上下文接管（桥接）待机。',
        '   解决：本 bundle 的 patch 已自动启用 compaction-basic；若仍缺失，',
        '        请在 profile patch 层加 { id: compaction-basic, disabled: false }。',
        '══════════════════════════════════════════════════════════',
      ].join('\n'));
    }
  } catch {}

  // ===== M3 水位配置 =====
  const CONTEXT_WINDOW = 128000;     // 兜底窗口（模型未知时；优先用 estimator 的 est.window）
  const FORCE_FOLD_THRESHOLD = 0.95; // 强折阈值：95%
  const TAIL_RETENTION = 20;         // 尾部保护窗：永远不折叠最新的 N 条消息

  const recordUsage = (wj, usage, provider, model, sessionId) => {
    const u = normalizeUsage(usage);
    if (!u) return;
    warmupModelWindow(wj, provider, model); // M3.6：顺手预热当前模型的窗口解析（并自学习落盘）
    const usageObj = {
      input_tokens: u.input,
      input: u.input,
      cached: u.cached,
      cached_tokens: u.cached,
    };
    // 先估算再落记录：estBy/khat/calibrating 入档，classifyMiss 才能归因（v0.6.3 修复 unattributed 空转）
    let est = null;
    try {
      const active = wj.ledger.getActiveMessages();
      if (active.length > 0 && u.input > 0) {
        est = wj.estimator.estimate({ messages: active }, { provider, model });
      }
    } catch {}
    // v0.7 baseline 附加量模型：首观测测量结构性开销（input − estRaw = system/tools/挂载前历史），
    // 宿主压缩导致间距收缩时向下跟踪（min 规则）。k̂ 的残差 = input − baseline，回归纯估算误差。
    let baseline = 0;
    try {
      if (sessionId && u.input > 0 && est) {
        // v0.7.6 P2(C2)：estRaw 高估样本（rawGap≤0）不得采纳——min 规则会把 baseline 永久锁 0。
        // 下行保持 min 即时收敛，上行改慢速 EMA（10%/次）自愈。
        const rawGap = u.input - est.estRaw;
        const prev = plugin._sessionBaseline?.get(sessionId);
        if (rawGap > 0) {
          if (!prev || rawGap < prev.baseline) {
            plugin._sessionBaseline.set(sessionId, { baseline: rawGap, t: Date.now() });
          } else if (rawGap > prev.baseline) {
            prev.baseline = prev.baseline + (rawGap - prev.baseline) * 0.1;
            prev.t = Date.now();
          }
          baseline = plugin._sessionBaseline.get(sessionId)?.baseline ?? 0;
        } else if (prev) {
          baseline = prev.baseline; // 高估样本：沿用既有基线
        }
      }
    } catch {}
    plugin._lastUsageRecord?.set(sessionId, { provider, model, t: Date.now() }); // v0.7.7 P1-8(D)：内存缓存
    try {
      wj.diagnoser.record({
        usage: usageObj,
        provider,
        model,
        est: est ?? undefined,
        khat: est?.khat,
        calibrating: est?.calibrating,
        degraded: wj.estimator.getDegraded(),
        baseline,
      });
    } catch (e) {
      plugin.pushLog('warn', `diagnoser.record fail: ${e.message}`);
    }
    // k̂ 校准接线：observe.mjs 里的 observeUsage 此前无人喂真实 usage，
    // k̂ 永远停在先验 1.0，字符估算的膨胀无法收敛（真机实测水位虚高到 544%）。
    // 用「账本活跃消息的 estRaw vs 真实 input」喂 EMA；账本不含 system prompt，
    // 这部分开销会被 k̂ 一并吸收——对水位预测反而更准。
    try {
      if (est && u.input > 0) {
        wj.estimator.observeUsage({ provider, model, usageInputTokens: u.input, estRaw: est.estRaw, baseline });
      }
    } catch {}
    // v0.6.31：记录最近真实 input——它是水位的正确分子（天然含 system/tools/挂载前历史），
    // turn/end 水位判定时优先于 k̂ 预测值使用
    if (sessionId && u.input > 0) {
      (plugin._lastRealInput ?? new Map()).set(sessionId, { input: u.input, t: Date.now() });
    }
  };

  // ===== M3.6：动态窗口感知（跟随实际服务模型自适应）=====
  // 窗口取值链：宿主注册表 ctx.llm.resolveModelInfo（权威，含 patch 层配置的
  // contextWindow）→ models.json + 已学习窗口（estimator）→ 128K 兜底。
  // 换模型即时自适应：每次真实 usage 到达时按 provider/model 异步预热缓存。
  // M3.6b 自学习：解析成功的窗口持久化到 <数据目录>/models.learned.json，
  // 下次加载合并进 estimator——别人用任何模型都零配置、自愈、无需发版。
  // M4：窗口缓存 TTL（默认 30 分钟，config.windowTtlMs 可调）——宿主侧配置突变自动嗅探
  const WINDOW_TTL = Number(config.windowTtlMs) > 0 ? Number(config.windowTtlMs) : 30 * 60 * 1000;
  const _windowCache = new Map(); // key -> { w, at }（解析失败不缓存 w，下次重试）
  const mergeLearned = (wj, provider, model, info) => {
    try {
      const models = wj.estimator.models;
      const p = (models[provider] ??= {});
      p[model] = {
        ...p[model],
        ...(typeof info?.context?.contextWindow === 'number' ? { window: info.context.contextWindow } : {}),
        ...(typeof info?.defaultMaxTokens === 'number' ? { output: info.defaultMaxTokens } : {}),
      };
    } catch {}
  };
  const persistLearned = (wj, provider, model, info) => {
    try {
      const path = join(plugin.dir, 'models.learned.json'); // 模型知识全局，不随会话分片
      let disk = {};
      try { disk = JSON.parse(readFileSync(path, 'utf8')); } catch {}
      const m = (disk[provider] ??= {});
      m[model] = {
        ...(m[model] ?? {}),
        ...(typeof info?.context?.contextWindow === 'number' ? { window: info.context.contextWindow } : {}),
        ...(typeof info?.defaultMaxTokens === 'number' ? { output: info.defaultMaxTokens } : {}),
      };
      const tmp = path + '.tmp';
      writeFileSync(tmp, JSON.stringify(disk, null, 2), 'utf8');
      renameSync(tmp, path); // 原子替换
    } catch (e) {
      plugin.pushLog('warn', `M3.6：学习窗口落盘失败：${e.message}`);
    }
  };
  const warmupModelWindow = (wj, provider, model) => {
    if (!provider) return;
    if (_windowCache.size >= 50) _windowCache.clear(); // P2：上限防无限增长（用户模型数有限，清空代价一次重解析）
    const key = `${provider}/${model ?? ''}`;
    const cached = _windowCache.get(key);
    if (cached && Date.now() - cached.at < WINDOW_TTL) return; // 新鲜缓存或 in-flight 占位
    const staleW = cached && Number.isFinite(cached.w) ? cached.w : NaN; // 刷新期间沿用旧值，水位不抖动
    _windowCache.set(key, { w: staleW, at: Date.now() });
    try {
      const llm = ctx.llm;
      if (!llm || typeof llm.resolveModelInfo !== 'function') {
        _windowCache.delete(key);
        return;
      }
      Promise.resolve()
        .then(() => llm.resolveModelInfo(provider, model ?? ''))
        .then((info) => {
          const w = info?.context?.contextWindow;
          if (typeof w === 'number' && w > 0) {
            _windowCache.set(key, { w, at: Date.now() });
            if (wj) { mergeLearned(wj, provider, model ?? '', info); persistLearned(wj, provider, model ?? '', info); }
            plugin.pushLog('log', `M3.6：模型窗口已解析 ${key} = ${w}`);
          } else {
            _windowCache.delete(key); // 注册表没给窗口，留待重试/走兜底
          }
        })
        .catch((err) => {
          _windowCache.delete(key);
          plugin.pushLog('warn', `M3.6：模型窗口解析失败 ${key}：${err?.message ?? err}（退回 models.json/兜底）`);
        });
    } catch (e) {
      _windowCache.delete(key);
      plugin.pushLog('warn', `M3.6：窗口解析调用异常：${e.message}`);
    }
  };

  // ===== M3.5：真实上下文接管（桥接宿主原生 compaction 服务）=====
  // 宿主契约（2026-11-14 Inspect 实查）：
  //   agent/pre-step 只给本轮 UserMessage[]；agent/request 明文 "cannot mutate messages"；
  //   llm/stream 的 LOOP 请求深度冻结（reconstructability）。
  // 唯一合法的「动刀」入口是 ctx.compaction.compactRegion(startSeq, endSeq, agent)：
  // 成功后真实会话日志的那段区间被替换成一个摘要节点，模型可见、缓存责任归宿主。
  let _compactUnavailableWarned = false;
  // 桥接状态持久化（host-bridge.json）：账本已折、宿主未折的块由 wj_reconcile 补桥
  const markBridge = (sid, blockId, status, error) => {
    // v0.6.20：sid 由发起方锁定——异步回调完成时 _currentSessionId 可能已切换，
    // 猜当前会话会把 A 的状态写进 B 的 host-bridge.json（竞态推演属实）
    if (!blockId || !plugin.dir) return;
    try {
      const srec = plugin.getOrCreate(sid ?? 'default');
      const rec = { status, at: Date.now(), ...(error ? { error: String(error).slice(0, 200) } : {}) };
      srec.bridgeStatus = srec.bridgeStatus ?? {};
      srec.bridgeStatus[blockId] = rec;
      const bridgePath = join(srec.sid, 'host-bridge.json');
      const tmpPath = bridgePath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(srec.bridgeStatus, null, 2), 'utf8');
      renameSync(tmpPath, bridgePath); // 原子替换：多进程下不会读到半截 JSON
    } catch (e) {
      // v0.7.7 P1-9(D)：桥接状态持久化失败不得静默——它直接影响补桥对账（僵尸判定/终态跳过）
      plugin.pushLog('warn', `host-bridge.json 持久化失败（${blockId} → ${status}）：${e.message}`);
    }
  };
      // M4.4：崩溃遗留锁修复——镜像宿主自身的失败收尾路径（补写补偿 compaction/end）。
      // 宿主锁语义：未匹配 start 阻塞一切压缩入口；其自愈依赖 session/end-seed，
      // 崩溃后若不产生 end-seed 则锁到会话终止——这里主动对账解锁。
      const busyLockRepair = async (sess, sid) => { // v0.7.6：sid 入参（宽限窗判定）
        try {
          if (!sess || typeof sess.append !== 'function' || typeof sess.eventAt !== 'function') return false;
          const scanUnmatched = () => {
            for (let q = Number(sess.seq) - 1; q >= 0; q -= 1) {
              const ev = sess.eventAt(q);
              if (!ev) continue;
              if (ev.type === 'compaction/start') return ev;
              if (ev.type === 'compaction/end') return null;
            }
            return null;
          };
          let unmatched = scanUnmatched();
          if (!unmatched) return false;
          const firstSeq = unmatched.seq; // v0.7.5 P0-1：锁定首扫目标——重扫必须命中同一条
          const inFlightAtScan = plugin._bridgeInFlight ?? 0; // 首扫时在途数（反应式路径含失败的自身，基线化比较）
          // v0.6.32 刀一：补偿前等待重扫——上一实例的摘要可能仍在收尾，真 end 迟到落盘；
          // 立即补偿会造出「一个 start 两条 end」→ loader 判整本日志损坏 → 会话从侧栏消失
          // （尔水青禾案 5805 补偿 end + 5807 真 end）。等待时长可注入（测试用），默认 3 秒，
          // 与失败取证的秒级迟到窗口匹配。
          const waitMs = Number(plugin._repairWaitMs ?? 3000);
          await new Promise((ok) => setTimeout(ok, waitMs));
          unmatched = scanUnmatched();
          if (!unmatched) {
            plugin.pushLog('log', 'M4.4：重扫后发现 end 已自行落盘，跳过补偿');
            return false;
          }
          // v0.7.5 P0-1：重扫必须命中同一 seq 且无在途桥接——3 秒窗口内 wanjuan 自己的
          // 新桥接会追加新 start，对在途压缩补 end = 双 end（会话消失的回归路径）。放弃本轮零成本。
          if (unmatched.seq !== firstSeq || (plugin._bridgeInFlight ?? 0) > inFlightAtScan) { // 有【新增】在途桥接才阻断
            plugin.pushLog('log', `M4.4：重扫命中不同 start（seq ${unmatched.seq} ≠ ${firstSeq}）或有在途桥接，放弃本轮补偿（inFlight=${plugin._bridgeInFlight ?? 0} vs 首扫=${inFlightAtScan}）`);
            return false;
          }
          // v0.7.6 P0-2(C2)：孤儿压缩宽限窗——该会话最近有桥接超时，宿主可能仍在摘要，
          // 此时补 end 会与迟到的真 end 撞出双 end。窗内拒绝（过期后照常补偿）。
          const limboUntil = sid ? (plugin._bridgeLimbo?.get(sid) ?? 0) : 0;
          if (Date.now() < limboUntil) {
            plugin.pushLog('log', `M4.4：孤儿压缩宽限窗内（剩 ${Math.ceil((limboUntil - Date.now()) / 1000)}s），拒绝补偿以防双 end`);
            return false;
          }
          sess.append('compaction/end', {
            ...(unmatched.data ?? {}),
            error: { message: 'wanjuan crash-recovery: compensating end for unmatched compaction/start' },
          });
          plugin.pushLog('warn', `M4.4：检测到崩溃遗留压缩锁（seq ${unmatched.seq}），已补写补偿 end 解锁`);
          return true;
        } catch (e) {
          plugin.pushLog('warn', `M4.4：遗留锁修复失败：${e.message}`);
          return false;
        }
      };
      plugin.busyLockRepair = busyLockRepair; // 暴露供测试直呼（v0.6.32 刀一）

  const tryHostCompaction = (session, startSeq, endSeq, blockId, sid) => {
    try {
      // inject 已声明 'compaction'，正常走属性访问；万一访问控制仍拦截，退回契约可选路径 ctx.get
      let svc = null;
      try {
        svc = ctx.compaction;
      } catch {
        if (typeof ctx.get === 'function') svc = ctx.get('compaction');
      }
      if (!svc || typeof svc.compactRegion !== 'function') {
        if (!_compactUnavailableWarned) {
          _compactUnavailableWarned = true;
          plugin.pushLog('warn', 'M3.5：宿主 compaction 服务不可用（inject 后仍取不到实现），真实上下文暂不会收缩');
        }
        return null;
      }
      // 返回 promise 供手动路径 await：宿主 compactRegion 硬编码 whole-surface 稳定性，
      // 工具结果消息若落在摘要期间必然触发 "session surface changed"（2026-11-14 实测），
      // 所以手动折叠必须等压缩完成后再返回工具结果。
      // v0.6.5：发起即标 pending——补桥扫描据此跳过 in-flight 的块，杜绝重复压缩
      // （崩溃残留的 pending 无终态标记，下轮自然重试）
      markBridge(sid, blockId, 'pending');
      plugin._bridgeInFlight = (plugin._bridgeInFlight ?? 0) + 1; // M4.4：在途计数（busy 锁错误区分「自因并发」vs「崩溃遗留」）
      // v0.6.3：起点拆散 tool-call/result 对时，回退到最近 user 消息（步骤起点恒为平衡边界）
      const walkToUserStart = (sess, from) => {
        try {
          const nodes = sess?.surface?.nodes;
          if (!Array.isArray(nodes)) return null;
          const idx = nodes.indexOf(from);
          if (idx <= 0) return null;
          for (let i = idx - 1; i >= 0 && idx - i <= 20; i--) {
            const ev = sess.eventAt?.(nodes[i]);
            if (String(ev?.type ?? '').includes('user')) return nodes[i];
          }
        } catch {}
        return null;
      };
      // v0.6.9 风险四：signal 传入宿主（compactRegion 第 4 参）——超时时 ac.abort 
      // 真正通知宿主中止摘要，不再空烧 LLM；宿主不认 signal 时 race 仍兜底。
      const ac = new AbortController();
      const agent = session && typeof session === 'object' ? { session, options: {} } : undefined;
      const timeoutMs = Number(config.bridgeTimeoutMs) > 0 ? Number(config.bridgeTimeoutMs) : 180000;
      let timeoutRej;
      const timeoutP = new Promise((_, rej) => { timeoutRej = rej; });
      const bridgeTimer = setTimeout(() => {
        try { ac.abort(new Error('wanjuan: bridge timeout')); } catch {}
        timeoutRej(new Error(`M3.5：桥接超时（${Math.round(timeoutMs / 1000)}s，宿主摘要未返回）`));
      }, timeoutMs);
      if (bridgeTimer.unref) bridgeTimer.unref();
      timeoutP.catch(() => {}); // 迟到的拒绝不得成为 unhandledRejection
      const workP = Promise.resolve()
        .then(async () => {
          let start = startSeq;
          for (let attempt = 0; ; attempt++) {
            try {
              const res = await svc.compactRegion(start, endSeq, agent, ac.signal);
              if (attempt > 0) plugin.pushLog('log', `M3.5：起点回退 ${startSeq}→${start} 后重试成功`);
              return res;
            } catch (err) {
              const msg = String(err?.message ?? err);
              if (!msg.includes('not a balanced boundary') || !msg.includes('start seq') || attempt >= 3) throw err;
              const prev = walkToUserStart(session, start);
              if (prev === null || prev >= start) throw err;
              start = prev;
            }
          }
        });
        return Promise.race([workP, timeoutP])
        .then((res) => {
          clearTimeout(bridgeTimer);
          markBridge(sid, blockId, 'ok');
          plugin.pushLog('log', `M3.5：宿主原生压缩完成（seq ${startSeq}→${endSeq}）${res ? JSON.stringify(res).slice(0, 120) : ''}`);
        })
        .catch(async (err) => {
          clearTimeout(bridgeTimer);
          let msg = String(err?.message ?? err);
          // v0.7.6 P0-2(C2)：桥接超时 ≠ 宿主停止——abort 不保证宿主中止，孤儿压缩可能仍在跑。
          // 宽限窗内 busyLockRepair 不得对该会话补 end（补偿 end + 迟到真 end = 双 end = 会话消失）。
          if (msg.includes('桥接超时')) {
            (plugin._bridgeLimbo ??= new Map()).set(sid, Date.now() + timeoutMs + 60000);
          }
          // v0.6.9 风险一：崩溃遗留压缩锁——无其他在途桥接时补写补偿 end 并重试一次
          if (msg.includes('compaction lock is already active')) {
            if ((plugin._bridgeInFlight ?? 0) <= 1) {
              const repaired = await busyLockRepair(session, sid); // v0.7.6：带 sid 判宽限窗
              if (repaired) {
                try {
                  const res = await svc.compactRegion(startSeq, endSeq, agent, ac.signal);
                  markBridge(sid, blockId, 'ok');
                  plugin.pushLog('log', `M3.5：宿主原生压缩完成（遗留锁解锁后重试，seq ${startSeq}→${endSeq}）`);
                  return;
                } catch (retryErr) {
                  msg = String(retryErr?.message ?? retryErr);
                }
              }
            }
          }
          // v0.7.6 P0-2(C2)：撞锁发生在宽限窗内 → 孤儿压缩还占着宿主锁，挂起重试而非终态失败。
          if (msg.includes('compaction lock is already active') && Date.now() < (plugin._bridgeLimbo?.get(sid) ?? 0)) {
            markBridge(sid, blockId, 'pending', 'deferred: 孤儿压缩宽限窗内（先前的超时桥接可能仍在宿主侧运行），稍后重试');
            plugin.pushLog('log', 'M3.5：撞锁但处于孤儿压缩宽限窗——挂起重试');
            return;
          }
          // v0.6.4 失败分类：终态不重试（自动补桥才不会每轮空耗一次 LLM 摘要）
          if (msg.includes('not found in surface')) markBridge(sid, blockId, 'skip', '区间已不在宿主表面（早已压缩或锚点失效），视为对齐');
          else if (msg.includes('context length') || msg.includes('maximum context') || msg.includes('too long')) markBridge(sid, blockId, 'skip', '区间过大宿主无法摘要（超窗口）——账本保持折叠，宿主侧由原生压缩接管'); // v0.7.3 超窗口降级
          else if (msg.includes('no open turn')) markBridge(sid, blockId, 'pending', 'deferred: 当前回合未闭合，下一阈值重试'); // v0.6.32 刀二：前置拒绝挂起重试，不再终态停摆
          else if (msg.includes('summary is not smaller')) markBridge(sid, blockId, 'skip', msg);
          else if (msg.includes('not a balanced boundary')) markBridge(sid, blockId, 'skip', msg);
          else markBridge(sid, blockId, 'failed', msg);
          plugin.pushLog('warn', `M3.5：宿主压缩失败：${msg}`);
        })
        .finally(() => {
          clearTimeout(bridgeTimer);
          plugin._bridgeInFlight = Math.max(0, (plugin._bridgeInFlight ?? 1) - 1);
        });
    } catch (e) {
      plugin.pushLog('warn', `M3.5：宿主压缩调用异常：${e.message}`);
    }
  };
  plugin.tryHostCompaction = tryHostCompaction; // 手动折叠路径复用同一桥接
  plugin._windowCache = _windowCache; // 测试与诊断挂钩
  // v0.6.4：自动补桥（10 分钟限流）。turn/end 时排队执行；候选只含未达终态的块。
  plugin._autoReconcile = () => {
    const now = Date.now();
    if (now - (plugin._lastAutoReconcile ?? 0) < 10 * 60 * 1000) return Promise.resolve('限流跳过');
    plugin._lastAutoReconcile = now;
    return Promise.resolve()
      .then(() => plugin._toolReconcile())
      .then((r) => {
        if (r && !r.includes('没有需要补桥') && !r.startsWith('跳过') && !r.includes('已终态')) plugin.pushLog('log', `自动补桥：\n${r}`);
        return r;
      })
      .catch(() => '');
  };
  // 桥接状态已在 getOrCreate 创建会话时按会话加载（v0.6.19 多会话隔离）

  ctx.on('session/event', (a0, a1) => {
    // 宿主签名：'session/event'(session, event) —— a0 是 Session 对象（有 .id），
    // a1 才是 SessionEvent（有 .type/.data/.time）。
    const ev = a1 && a1.type ? a1 : a0;
    if (!ev || !ev.type) return;
    const sessionId = ev.sessionId ?? a0?.id ?? 'default';
    try {
      const { wj } = plugin.getOrCreate(sessionId);
      plugin._hostSessions.set(sessionId, a0); // v0.7.7 P1-4(D)：按会话记录宿主 Session
      plugin._lastHostSession = a0; // M3.5：兼容保留（最近一次事件流）
      if (plugin._currentSessionId !== sessionId) {
        // 多会话：切换当前会话，桥接状态随会话切换（每会话独立 host-bridge.json）
        plugin._currentSessionId = sessionId;
        plugin._bridgeStatus = plugin.getOrCreate(sessionId).bridgeStatus ?? {};
      }
      // M4：重启恢复——v0.6.21 起按会话独立踢脚：每个会话的首次事件各自触发一次
      // 冷启动扫描（A 先打开不再遮蔽 B 的遗留锁）
      const srecEv = plugin.getOrCreate(sessionId);
      if (!srecEv._recoveryKicked) {
        srecEv._recoveryKicked = true;
        Promise.resolve().then(async () => {
          // M4.4 冷启动探针：此刻本进程尚无任何压缩在途，发现的未匹配 start 必为崩溃遗留，直接对账解锁
          try { await busyLockRepair(a0); } catch {}
          // v0.7.2 启动回溯入账：从宿主表面反向重建挂载前历史（幂等——recordMsg 按 id 去重）。
          // 账本从此覆盖全会话：nudge/强折的候选池包含真实最老消息，baseline 收缩至 system+tools。
          try {
            const nodes = a0?.surface?.nodes;
            if (Array.isArray(nodes) && nodes.length > 0) {
              let backfilled = 0;
              for (const sq of nodes) {
                const sev = a0.eventAt?.(sq);
                const t = String(sev?.type ?? '');
                if (!t.includes('user') && !t.includes('assistant') && !t.includes('tool')) continue;
                const msg = (t.includes('assistant') || t.includes('tool')) ? sev?.data?.message : sev?.data;
                if (!msg?.id || wj.ledger.messages.has(msg.id)) continue;
                recordOne(wj, msg, sev?.time ?? Date.now(), sq);
                backfilled += 1;
              }
              if (backfilled > 0) plugin.pushLog('warn', `v0.7 启动回溯：从宿主表面回填 ${backfilled} 条挂载前消息（账本现在覆盖全会话）`);
            }
          } catch (e) { plugin.pushLog('warn', `启动回溯失败：${e.message}`); }
          return plugin._autoReconcile?.();
        }).catch(() => {});
      }

      // 宿主 SessionEventMap 的真实词汇（没有 'message'/'step'）：
      //   user/message      → data 就是 UserMessage 本体
      //   assistant/message  → data.message + data.usage（provider/model 在 message.source）
      //   tool/result        → data.message（ToolResultMessage）
      if (ev.type === 'user/message') {
        recordOne(wj, ev.data, ev.time, ev.seq);
      } else if (ev.type === 'assistant/message') {
        recordOne(wj, ev.data?.message, ev.time, ev.seq);
        if (ev.data?.usage) {
          const src = ev.data.message?.source ?? {};
          recordUsage(wj, ev.data.usage, src.provider, src.model, sessionId);
        }
      } else if (ev.type === 'tool/result') {
        recordOne(wj, ev.data?.message, ev.time, ev.seq);
      } else if (ev.type === 'turn/end') {
        // ==========================================
        // M3 核心引擎：在一轮对话彻底结束后，进行水位检查
        // ==========================================
        if (plugin.shadowMode || !wj.estimator || typeof wj.estimator.estimate !== 'function') return;

        // M4.6：fingerprint 观察模式——账本活跃 vs 宿主表面重建对比（限流 10 分钟，只读不驱逐）。
        // 宿主侧若绕过万卷自行压缩（压力触发），此处会看到账本活跃消息从表面消失的漂移。
        try {
          const fpNow = Date.now();
          if (fpNow - (plugin._lastFpProbe ?? 0) > 10 * 60 * 1000) {
            plugin._lastFpProbe = fpNow;
            const nodes = a0?.surface?.nodes;
            if (Array.isArray(nodes) && nodes.length > 0) {
              const surfaceIds = new Set();
              let readOk = 0; // v0.7.6 P1(C1)：表面节点读取成功计数
              let drift = 0; // v0.7.7 P0-3(D)：类型命中但提取不到 id 的节点数（宿主 data 形态漂移信号）
              for (const sq of nodes) {
                const sev = a0.eventAt?.(sq);
                if (sev) readOk++;
                const t = String(sev?.type ?? '');
                if (!t.includes('user') && !t.includes('assistant') && !t.includes('tool')) continue;
                const mid = (t.includes('assistant') || t.includes('tool')) ? sev?.data?.message?.id : sev?.data?.id;
                if (mid) surfaceIds.add(mid);
                else drift++; // v0.7.7 P0-3(D)：user/assistant/tool 节点竟无 id
              }
              const actives = wj.ledger.getActiveMessages();
              const missing = actives.filter((m) => !surfaceIds.has(m.id));
              // v0.7.7 P0-3(D)：护栏收紧到「全量读取成功且零形态漂移」——部分失败同样会把
              // 活消息误判为已压缩（evict 不可逆、无自动撤销路径），只观察不驱逐。
              if (missing.length > 0 && (readOk < nodes.length || drift > 0)) {
                plugin.pushLog('warn', `指纹对账（M5.1）：表面读取不完整（读 ${readOk}/${nodes.length}，形态漂移 ${drift}），本轮跳过驱逐防误删`);
              }
              if (missing.length > 0 && readOk === nodes.length && drift === 0) {
                // v0.7.4 M5.1b：驱逐判据升级——「不在表面 且 宿主已推进到其后」。
                // 消息不在 surfaceIds，且表面存在 seq 更大的节点 ⟹ 宿主已处理到该消息之后，
                // 它已被压缩/移除。对「最老收缩」与「中部空洞」两种宿主压缩形态都成立，
                // 零误驱逐：还活着的消息必在 surfaceIds 里。无 seq 的消息无法判定，保留观察。
                let maxSurfaceSeq = 0; // v0.7.5 P2-3：循环求 max（spread 在 >65K 节点时抛 RangeError → 探针静默停摆）
                for (const sq of nodes) if (Number.isFinite(sq) && sq > maxSurfaceSeq) maxSurfaceSeq = sq;
                const evictIds = missing
                  .filter((m) => typeof m.seq === 'number' && m.seq < maxSurfaceSeq)
                  .map((m) => m.id);
                if (evictIds.length > 0 && readOk > 0) { // readOk=0 时 evictIds 必为误判
                  wj.ledger.recordEvict({ ids: evictIds, why: 'reconcile' });
                  plugin.pushLog('warn', `指纹对账（M5.1）：账本活跃 ${actives.length} 条中 ${evictIds.length} 条已被宿主压缩（不在表面且宿主已推进到其后），已驱逐对齐：${evictIds.slice(0, 8).join(',')}${evictIds.length > 8 ? '…' : ''}`);
                }
                const rest = missing.length - evictIds.length;
                if (rest > 0) {
                  plugin.pushLog('log', `指纹观察：另有 ${rest} 条不在表面且无 seq 可判定（重建存疑），保留观察`);
                }
              }
            }
          }
        } catch (e) {
        // v0.7.5 P2-3：探针异常不再静默——30 分钟节流日志（停摆可见）
        const lastErrT = plugin._lastDivergeLog?.get('fp-err') ?? 0;
        if (Date.now() - lastErrT > 30 * 60 * 1000) {
          (plugin._lastDivergeLog ?? new Map()).set('fp-err', Date.now());
          plugin.pushLog('warn', `指纹探针异常（30 分钟节流）：${e.message}`);
        }
        }
        // M4.3：追加事件跨阈值 → 运行期摊销对数压缩（0000 卷即检查点，启动永不重压大账本）。
        // 放在水位早退之前：少量消息的 turn/end 也要能触发归并。
        try {
          if (wj.ledger._appendsSinceCompact > (wj.ledger._compactionThreshold ?? 5000)) {
            plugin.pushLog('log', `账本自压缩：${wj.ledger._appendsSinceCompact} 个事件归并为等价极简流`);
            wj.ledger.compactNow();
          }
        } catch (e) {
          // v0.7.6 P0(C1)：自压缩失败不得静默——砖化征兆必须可见
          plugin.pushLog('warn', `账本自压缩失败（保留原账本，重启重试）：${e.message}`);
        }

        // 注意：Estimator 没有 estRaw 方法（那是 estimate() 返回值的字段）；
        // 且宿主消息 id 是 UUID，字典序≠时间序（2026-11-14 实测），必须按 at 排出真实时间序。
        const activeMsgs = wj.ledger.getActiveMessages();
        if (activeMsgs.length <= TAIL_RETENTION) return;
        const byTime = [...activeMsgs].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

        let provider = '', model = '';
        // v0.7.7 P1-8(D)：优先内存缓存，miss 才读盘（原每轮全量解析 ≤5MB）
        const lastU = plugin._lastUsageRecord?.get(sessionId);
        if (lastU?.provider) {
          provider = lastU.provider; model = lastU.model ?? '';
        } else {
          try {
            const last = wj.diagnoser.readAll().at(-1);
            if (last?.provider) { provider = last.provider; model = last.model ?? ''; }
          } catch (e) {
            // v0.7.6 P1(C1)：读取失败必须可见——静默跌回 128K 兜底会误强折大窗口会话
            plugin.pushLog('warn', `requests.jsonl 读取失败（provider/model 探测降级 128K 窗口）：${e.message}`);
          }
        }

        const est = wj.estimator.estimate({ messages: byTime }, { provider, model });
        // M3.6：窗口三级取值——宿主注册表（动态预热缓存）→ models.json → 128K 兜底
        const wEntry = _windowCache.get(`${provider}/${model ?? ''}`);
        const hostWindow = wEntry && Number.isFinite(wEntry.w) ? wEntry.w : undefined;
        const window = (typeof hostWindow === 'number' && hostWindow > 0)
          ? hostWindow
          : (est.window && est.window > 0 ? est.window : CONTEXT_WINDOW);
        // 用 estFinal（k̂ 校准 + 5% 偏置）做水位，比 estRaw 更保守
        // P1-A：分母减去 output reserve，与 estimator.fits 语义对齐（否则折叠偏晚约 output×0.95）
        // 已知边界：est.output 与 window 不同源（output 静态来自 models.json/学习文件，window 动态解析自宿主注册表）——
        // 未知模型 output 兜底 8192，对大窗口偏保守（折叠偏早方向，安全）
        const usable = Math.max(1, window - (est.output ?? 0));
        // v0.7 baseline 附加量模型：账面水位 = (estFinal + baseline) / usable——
        // estFinal 只含账本可见消息的估算，结构性开销（system/tools/挂载前历史）由 baseline 加法补上。
        const sessionBaseline = plugin._sessionBaseline?.get(sessionId)?.baseline ?? 0;
        let usageRatio = (est.estFinal + sessionBaseline) / usable;
        // v0.6.31 止血：有新鲜真实观测（30 分钟内）时，水位以真实 input 为准（观测 > 预测）。
        // Day-1 实测：clipped-k̂ 钉死 5.0 的会话，账面水位 102.2% 而真实仅 62%——k̂ 乘数在
        // 「永久性结构缺口」（挂载前历史不在账本）面前数学上无解，EMA 钉死不收敛，
        // 误触发强制折叠（白折 1679 条）。真实 input 天然是正确分子，直接采用。
        // 已知残差：真实 input 是「上一次请求」的观测，不含当前 turn 新增的消息——
        // 极端场景（单 turn 涌入巨量工具输出）下可能低估一轮；30 分钟新鲜窗封顶风险，
        // 且宿主自身压缩是真实溢出的最后防线（wanjuan 强折只是助手，不是唯一防线）。
        try {
          const real = plugin._lastRealInput?.get(sessionId);
          if (real && Date.now() - real.t < 30 * 60 * 1000 && Number.isFinite(real.input) && real.input > 0) {
            const realRatio = real.input / usable;
            if (Math.abs(realRatio - usageRatio) > 0.2) {
              // 节流：钉死会话每个 turn 都背离，10 分钟内不重复打，防淹没日志环
              const lastDivergeT = plugin._lastDivergeLog?.get(sessionId) ?? 0;
              if (Date.now() - lastDivergeT > 10 * 60 * 1000) {
                (plugin._lastDivergeLog ?? new Map()).set(sessionId, Date.now());
                plugin.pushLog('log', `[水位] 账面 ${(usageRatio * 100).toFixed(1)}% vs 真实 ${(realRatio * 100).toFixed(1)}%（背离 >20%，以真实为准——k̂ 受结构性缺口影响）`);
              }
            }
            usageRatio = realRatio;
          }
        } catch {}
        let foldBridge = null; // 本轮折叠的宿主桥接 promise（供自动补桥排队）

        if (usageRatio >= FORCE_FOLD_THRESHOLD) {
          plugin.pushLog('warn', `🚨 水位达到 ${(usageRatio * 100).toFixed(1)}%（模型 ${provider || '?'}/${model || '?'}，窗口 ${window}）！正在强制执行后台保护性折叠...`);
          const toFold = byTime.slice(0, byTime.length - TAIL_RETENTION);
          try {
            // 关键：按显式 id 列表折叠。传 range 端点在 UUID id 下会按字典序
            // 折出一段随机邻域，保尾 20 条完全不成立。
            const n = toFold.length;
            const summary = `【万卷引擎自动折叠】水位已达 ${(usageRatio * 100).toFixed(1)}%，最老的 ${n} 条消息已折叠为本摘要；如需原文可用 wj_decompress 恢复。`;
            // v0.6.12：折叠前算好宿主 seq 跨度，随 fold 事件入账（审计可追溯）
            const foldSeqs = toFold.map((m) => m.seq).filter((x) => typeof x === 'number');
            const foldSeqSpan = foldSeqs.length ? [foldSeqs.reduce((a, b) => (a < b ? a : b)), foldSeqs.reduce((a, b) => (a > b ? a : b))] : undefined; // v0.7.7 P1-3(D)：reduce 防栈溢出
            const blockId = wj.compressor.compress({
              ids: toFold.map((m) => m.id),
              seqSpan: foldSeqSpan,
              summary,
              // 摘要自身的 token 成本（此前漏传，块元数据 sumTok 恒为 0）
              sumTok: wj.estimator.estimate({ messages: [{ tok: estimateTok(summary), cls: 'text' }] }, { provider, model }).estRaw, // P0-8：estimate 只读 tok，bytes 恒 0
            });
            plugin.pushLog('log', `✅ 自动折叠完成：块 ${blockId}，账本释放 ${n} 条消息。`);
            // M3.5：账本折完，桥接宿主原生压缩，把真实会话日志的同段区间也收掉
            const seqs = toFold.map((m) => m.seq).filter((s) => typeof s === 'number');
            if (seqs.length > 0) {
              const lo = seqs.reduce((a, b) => (a < b ? a : b)), hi = seqs.reduce((a, b) => (a > b ? a : b)); // v0.7.7 P1-3(D)：reduce
              foldBridge = tryHostCompaction(a0, lo, hi, blockId, sessionId);
            }
          } catch (err) {
            plugin.pushLog('error', `自动折叠失败: ${err.message}`);
          }
        } else if (usageRatio >= 0.80) {
          // M5.2：结构化 nudge 产出。80% 水位触发（Gate 的 growth 门留给 L2；
          // 方案 B 语义已定：lastFoldEstRaw 取折叠后 estRaw——折叠前基线会让 growth 变负数长哑火）
          const pool = byTime.slice(0, byTime.length - TAIL_RETENTION);
          const cand = pool;
          const cseqs = cand.map((m) => m.seq).filter((x) => typeof x === 'number');
          const clo = cseqs.reduce((a, b) => (a < b ? a : b)), chi = cseqs.reduce((a, b) => (a > b ? a : b)); // v0.7.7 P1-3(D)：reduce
          const span = cseqs.length ? `（seq ${clo}→${chi}，共 ${cand.length} 条）` : `（共 ${cand.length} 条）`;
          // v0.7.7 P1-5(D)：宿主缺 turn 字段时自增兜底——否则 _injectedTurns 恒记 {0}，
          // 第二个 pending 起全被防御分支吞掉，nudge 一生只注入一次。
          plugin._turnCounter = (plugin._turnCounter ?? 0) + 1;
          const turnNo = ev.data?.turn ?? plugin._turnCounter;
          // v0.6.35 二次确认：Day-3 实测个别 turn/end 的观测>预测纠偏未生效
          // （bb00f425 真实 26~32% 时仍产出 6 次）——产出前用最近真实观测复核，
          // 双重保险；无新鲜观测时记诊断日志，定位失效路径。
          let skipNudge = false;
          try {
            const realNow = plugin._lastRealInput?.get(sessionId);
            if (realNow && Date.now() - realNow.t < 30 * 60 * 1000 && realNow.input > 0) {
              const realRatioNow = realNow.input / usable;
              if (realRatioNow < 0.80) {
                skipNudge = true;
                plugin.pushLog('log', `[nudge] 二次确认：真实水位 ${(realRatioNow * 100).toFixed(1)}% < 80%，跳过产出（账面 ${(usageRatio * 100).toFixed(1)}%）`);
              }
            } else {
              const lastT = plugin._lastDivergeLog?.get(sessionId + '|nn') ?? 0;
              if (Date.now() - lastT > 30 * 60 * 1000) {
                (plugin._lastDivergeLog ?? new Map()).set(sessionId + '|nn', Date.now());
                plugin.pushLog('log', '[nudge] 无新鲜真实观测，按账面水位产出（诊断）');
              }
            }
          } catch {}
          let nudgeMsg = null;
          let candidateIds = [];
          let candidates = []; // v0.7.7 P0-1(D)：候选对象（含各自 range），reject/accept 逐候选记账
          try {
            // 池已按 TAIL_RETENTION 切过，禁用 findCandidates 内部的二次尾部保留
            candidates = wj.nudge.findCandidates(pool, { tailKeepTok: 0 });
            if (candidates.length > 0) {
              nudgeMsg = wj.nudge.buildNudgeMessage(candidates, turnNo);
              candidateIds = candidates.flatMap((c) => [c.range[0], c.range[1]]);
            }
          } catch (e) {
            plugin.pushLog('warn', `[nudge] 构建失败：${e.message}`);
          }
          if (!skipNudge && nudgeMsg) {
            // 风险 B 接线：上一轮 nudge 已送达但模型未消费（消费走 accept 清账）→ 记 reject 降频，防 nagging
            const old = plugin._pendingNudge.get(sessionId);
            if (old && old.injectedAt !== undefined && old.turn !== turnNo && old.candidateIds.length > 0) {
              try {
                // v0.7.7 P0-1(D)：逐候选记账（并集 key 清不掉单候选状态）
                wj.nudge.recordRejectCandidates(old.candidates ?? [], turnNo);
                plugin.pushLog('log', `[nudge] 上一轮 nudge 未被消费（turn ${old.turn}），已按 ${old.candidates?.length ?? 0} 个候选记 reject 降频`);
              } catch (e) { plugin.pushLog('warn', `[nudge] reject 记账失败：${e.message}`); }
            }
            plugin._pendingNudge.set(sessionId, { message: nudgeMsg, turn: turnNo, candidateIds, candidates });
            plugin.pushLog('warn', `⚠️ 水位达到 ${(usageRatio * 100).toFixed(1)}%，nudge 已产出（turn ${turnNo}，${nudgeMsg.tok} tok），待下轮 pre-step 注入${span}。`);
          } else if (!skipNudge) {
            plugin.pushLog('warn', `⚠️ 水位达到 ${(usageRatio * 100).toFixed(1)}%，nudge 被降频规则过滤（建议主动调用 wj_compress 折叠最老消息${span}）。`);
          }
        }
        // v0.6.4：自动补桥——本轮若有折叠桥接则排队在其后，避免宿主并发压缩冲突
        Promise.resolve(foldBridge).then(() => plugin._autoReconcile?.()).catch(() => {});
      }
    } catch (e) {
      plugin.pushLog('warn', `session/event ${ev.type} fail: ${e.message}`);
    }
  });

  // M5.2：agent/pre-step waterfall —— 把 pending nudge 送达模型
  // 配方（探针实证）：注入消息必须带 source.kind，否则宿主 'reading kind' 崩溃；form 宿主不读，仅自文档化
  try {
    ctx.on('agent/pre-step', (plugin._preStepHandler = async (payload, next) => {
      const decision = await next();
      try {
        // 风险 A 自愈：agent.id 与事件 sessionId 的字符串格式不赌——多 key 逐个命中，
        // _currentSessionId 兜底保证「事件后必命中」（pre-step 前必有本会话事件）
        const keyCandidates = [...new Set([payload?.agent?.id, payload?.sessionId, plugin._currentSessionId, 'default'].filter(Boolean))];
        const hitKey = keyCandidates.find((k) => plugin._pendingNudge.has(k));
        const sessionId = hitKey ?? keyCandidates[0];
        const pending = hitKey ? plugin._pendingNudge.get(hitKey) : undefined;
        if (pending) {
          const turnNo = payload?.turn ?? pending.turn;
          if (turnNo - pending.turn > 3) {
            // 陈旧 nudge（跨 3 turn 未送达/未消费）——丢弃，防迟到注入打乱上下文
            plugin.pushLog('log', `[nudge] pending 已陈旧（turn ${pending.turn} → ${turnNo}），丢弃`);
            plugin._pendingNudge.delete(hitKey);
          } else if ((plugin._injectedTurns.get(hitKey) ?? new Set()).has(turnNo)) {
            plugin._pendingNudge.delete(hitKey); // 防御性兜底
          } else {
            const msgs = decision?.messages;
            if (!Array.isArray(msgs) || Object.isFrozen(msgs) || msgs.length === 0) {
              plugin.pushLog('warn', '[nudge] pre-step decision.messages 不可写或为空，跳过注入');
              plugin._pendingNudge.delete(hitKey);
            } else {
              const nudgeMsg = {
                id: pending.message.id ?? `wj-nudge-${turnNo}-${Date.now()}`,
                role: 'user',
                content: [{ type: 'text', text: pending.message.content }],
                source: { kind: 'wanjuan-nudge', form: 'nudge' }, // ★ 必填（探针实证）
              };
              // 插在最后一条 claimed 之后（第一方同款，缓存友好）；claimed 缺失时追加末尾
              const claimed = payload?.messages ?? [];
              const lastClaimedIndex = msgs.findLastIndex((m) => claimed.includes(m));
              const at = lastClaimedIndex >= 0 ? lastClaimedIndex + 1 : msgs.length;
              const entered = msgs.toSpliced(at, 0, nudgeMsg);
              const injectedNow = plugin._injectedTurns.get(hitKey) ?? new Set();
              injectedNow.add(turnNo);
              plugin._injectedTurns.set(hitKey, injectedNow.size > 20 ? new Set([...injectedNow].sort((a, b) => a - b).slice(-10)) : injectedNow);
              // v0.6.29 修订：注入后【保留】pending 并标记 injectedAt——
              // 消费归 accept（wj_compress 命中候选 → recordAccept + delete）；
              // 未消费的 injected pending 由下轮 turn/end 记 reject 降频。此处 delete 会让 accept 永远查空（死代码）
              pending.injectedAt = turnNo;
              plugin.pushLog('log', `[nudge] 已注入（session ${String(sessionId).slice(0, 8)}, turn ${turnNo}, ${pending.message.tok} tok）`);
              return { ...decision, messages: entered };
            }
          }
        }
      } catch (e) {
        plugin.pushLog('warn', `[nudge] pre-step 注入失败：${e.message}`);
      }
      return decision;
    }));
  } catch (e) {
    plugin.pushLog('warn', `[nudge] pre-step waterfall 注册失败：${e.message}`);
  }

  for (const t of buildTools(plugin)) {
    try {
      ctx.tools.register(t);
    } catch (e) {
      plugin.pushLog('warn', `tool register fail ${t.name}: ${e.message}`);
    }
  }

  return plugin; // v0.7.6：返回实例——与幂等复用路径的返回一致
}