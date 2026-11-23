// src/ledger.mjs
const COMPACTION_THRESHOLD = 5000; // 事件数超过此值时自动对数压缩
export class InvariantError extends Error {
  constructor(name, detail) {
    super(`不变式 ${name} 违反：${detail}`);
    this.name = 'InvariantError';
    this.invariant = name;
  }
}

export class Ledger {
  constructor({ store, compactionThreshold = COMPACTION_THRESHOLD }) {
    this._compactionThreshold = compactionThreshold; // M4：阈值可配（不同会话规模自选）
    this.store = store;
    this.messages = new Map();
    this.blocks = new Map();
    this.pendingCompress = null;
    this.degraded = [];
    // M4.3：运行期追加计数——turn/end 跨阈值时摊销式压缩，启动永不重压大账本
    this._appendsSinceCompact = 0;
    const rawAppend = this.store.append.bind(this.store);
    this.store.append = (ev) => {
      this._appendsSinceCompact += 1;
      return rawAppend(ev);
    };
    this._replay();
    // M4.1：账本自压缩——事件超阈值时生成等价极简流并归档旧卷（重放延迟有界）
    if (this._lastReplayEventCount > this._compactionThreshold) {
      try { this.compactNow(); } catch { this._degrade('compact-fail'); }
    }
  }

  _replay() {
    const state = this.store.replay();
    this._lastReplayEventCount = state.events.length;
    for (const ev of state.events) {
      // v0.7.6 P1(C1)：合法 JSON 但形状非法的事件（null / 缺 range 的 fold / 缺 ids 的 evict）
      // 与 store 的 json-parse-error 同等宽容：记 degraded 跳过，构造函数不再崩。
      try { this._apply(ev); } catch (e) { this._degrade(`malformed-event(${(ev && ev.k) ?? String(ev)}): ${e.message}`); }
    }
  }

  _apply(ev) {
    if (ev.k === 'msg') {
      if (!this.messages.has(ev.id)) this.messages.set(ev.id, { ev, status: 'active' });
    } else if (ev.k === 'mut') {
      const m = this.messages.get(ev.id);
      if (m) {
        m.ev = { ...m.ev, ...(ev.bytes !== undefined ? { bytes: ev.bytes } : {}) }; // v0.7.6 P2(C1)+v0.7.7 P2-8(D)：content/bytes 缺失都不得抹掉原值
        if (ev.content !== undefined) m.ev.content = ev.content;
        if (ev.tok !== undefined) m.ev.tok = ev.tok; // M4：突变后 token 估算同步更新，水位不漂移
        m.ev.mutatedAt = ev.at;
      }
    } else if (ev.k === 'fold') {
      const block = {
        id: ev.block, tier: ev.tier, range: ev.range,
        srcTok: ev.srcTok, sumTok: ev.sumTok,
        rawRef: ev.rawRef, note: ev.note,
        seqSpan: ev.seqSpan || null,       // v0.6.12：宿主侧 seq 跨度（审计可追溯）
        atRange: ev.atRange || null,       // 时间锚
        ids: ev.ids || null,               // M3：显式 id 集合（UUID 主机的 id 字典序≠时间序）
        children: undefined, promotedInto: undefined,
      };
      this.blocks.set(ev.block, block);
      if (Array.isArray(ev.ids)) {
        // 精确集合折叠：不依赖 id 排序
        const want = new Set(ev.ids);
        for (const [id, m] of this.messages) {
          if (want.has(id) && m.status === 'active') {
            m.status = 'folded';
            m.blockId = ev.block;
          }
        }
      } else {
        // 旧语义：id 字典序区间（仅当 id 排序与时间序一致时才安全）
        const [start, end] = ev.range;
        for (const [id, m] of this.messages) {
          if (id >= start && id <= end && m.status === 'active') {
            m.status = 'folded';
            m.blockId = ev.block;
          }
        }
      }
    } else if (ev.k === 'evict') {
      for (const id of ev.ids) {
        const m = this.messages.get(id);
        if (m) m.status = 'evicted';
      }
    } else if (ev.k === 'unfold') {
      const b = this.blocks.get(ev.block);
      if (b) {
        if (Array.isArray(b.ids)) {
          // v0.6.15 P0-7：ids 精确展开——ids 路径 fold 的 range 端点未按字典序排序，
          // 旧区间扫描会静默空转（start > end 匹配为零），与 fold 的 ids 语义对称
          for (const id of b.ids) {
            const m = this.messages.get(id);
            if (m && m.status === 'folded' && m.blockId === ev.block) {
              m.status = 'active';
              m.blockId = undefined;
            }
          }
        } else {
          const [start, end] = b.range;
          for (const [id, m] of this.messages) {
            if (id >= start && id <= end && m.status === 'folded' && m.blockId === ev.block) {
              m.status = 'active';
              m.blockId = undefined;
            }
          }
        }
        this.blocks.delete(ev.block);
      }
    } else if (ev.k === 'promote') {
      let parent = this.blocks.get(ev.parent);
      if (!parent) {
        parent = {
          id: ev.parent, tier: ev.tier, range: null,
          srcTok: ev.srcTok, sumTok: ev.sumTok,
          rawRef: null, note: undefined,
          atRange: ev.atRange || null,     // 时间锚
          children: undefined, promotedInto: undefined,
        };
        this.blocks.set(ev.parent, parent);
      }
      parent.children = ev.children;
      parent.srcTok = ev.srcTok;
      parent.sumTok = ev.sumTok;
      parent.tier = ev.tier;
      parent.atRange = ev.atRange || parent.atRange;
      for (const c of ev.children) {
        const child = this.blocks.get(c);
        if (child) child.promotedInto = ev.parent;
      }
    }
  }

  _degrade(kind) { if (!this.degraded.includes(kind)) this.degraded.push(kind); }
  getDegraded() { return [...this.degraded]; }

  recordMsg({ id, at = 0, bytes = 0, tok = 0, cls = 'text', gen = 0, content, seq }) {
    const existing = this.messages.get(id);
    // v0.6.15 P0-5：已存在（含已折叠/已驱逐）一律不再落事件——宿主重投递不污染日志
    if (existing) return existing.ev;
    const ev = { k: 'msg', id, at, bytes, tok, cls, gen };
    if (content !== undefined) ev.content = content;
    if (seq !== undefined) ev.seq = seq;  // M3.5：宿主会话日志序号，用于 compactRegion 区间映射
    this.store.append(ev);
    this._apply(ev);
    return ev;
  }

  recordMut({ id, at = Date.now(), bytes, content, tok }) {
    const m = this.messages.get(id);
    if (!m) throw new InvariantError('归属唯一', `mut 目标消息 ${id} 不存在`);
    const ev = { k: 'mut', id, at, bytes, content, ...(tok !== undefined ? { tok } : {}) };
    this.store.append(ev);
    this._apply(ev);
    return ev;
  }

  recordFold({ block, ids, range, srcTok, sumTok, tier, rawRef, note, atRange, seqSpan }) {
    if (!rawRef) throw new InvariantError('原文可达', `fold ${block} 缺少 rawRef`);
    if (this.pendingCompress !== null && this.pendingCompress !== block) {
      throw new InvariantError('并发唯一', `已有未决 compress ${this.pendingCompress}`);
    }

    if (Array.isArray(ids)) {
      // M3 精确集合折叠：不依赖 id 字典序（宿主 UUID id 的时间序与字典序无关）
      if (ids.length === 0) throw new InvariantError('归属唯一', `fold ${block} 的 ids 为空`);
      let found = 0;
      for (const id of ids) {
        const m = this.messages.get(id);
        if (!m) throw new InvariantError('归属唯一', `消息 ${id} 不存在`);
        if (m.status === 'folded') throw new InvariantError('归属唯一', `消息 ${id} 已属于块 ${m.blockId}`);
        if (m.status === 'evicted') throw new InvariantError('归属唯一', `消息 ${id} 已 evict`);
        found++;
      }
      if (found === 0) throw new InvariantError('归属唯一', `fold ${block} 的 ids 无活跃消息`);
      const ev = { k: 'fold', block, ids: [...ids], range: [ids[0], ids[ids.length - 1]],
        srcTok, sumTok, tier, rawRef,
        ...(seqSpan ? { seqSpan } : {}),
        ...(note ? { note } : {}), ...(atRange ? { atRange } : {}) };
      this.store.append(ev);
      this._apply(ev);
      this.pendingCompress = null;
      return ev;
    }

    // 旧语义：id 字典序区间
    const [start, end] = range;
    let found = 0;
    for (const [id, m] of this.messages) {
      if (id >= start && id <= end) {
        found++;
        if (m.status === 'folded') throw new InvariantError('归属唯一', `消息 ${id} 已属于块 ${m.blockId}`);
        if (m.status === 'evicted') throw new InvariantError('归属唯一', `消息 ${id} 已 evict`);
      }
    }
    if (found === 0) throw new InvariantError('归属唯一', `区间 ${range} 内无消息`);
    const ev = { k: 'fold', block, range, srcTok, sumTok, tier, rawRef,
      ...(note ? { note } : {}), ...(atRange ? { atRange } : {}) };
    this.store.append(ev);
    this._apply(ev);
    this.pendingCompress = null;
    return ev;
  }

  recordUnfold({ block, why }) {
    // v0.6.33：'repair' = 纯记账修复（误折叠纠正），不投递原文——原文可达仍由 raw 归档保证
    if (!['context', 'file', 'repair'].includes(why)) {
      throw new InvariantError('原文可达', `unfold why 非法：${why}`);
    }
    const ev = { k: 'unfold', block, why };
    this.store.append(ev);
    this._apply(ev);
    return ev;
  }

  recordEvict({ ids, why }) {
    if (!['reconcile', 'host-compact'].includes(why)) {
      throw new InvariantError('归属唯一', `evict why 非法：${why}`);
    }
    const ev = { k: 'evict', ids, why };
    this.store.append(ev);
    this._apply(ev);
    return ev;
  }

  recordPromote({ parent, children, srcTok, sumTok, tier }) {
    if (!Array.isArray(children) || children.length === 0) {
      throw new InvariantError('归属唯一', `promote ${parent} 缺少子块`);
    }
    // 时间锚：所有 children 的 atRange 并集
    let atMin = Infinity, atMax = -Infinity;
    for (const cId of children) {
      const c = this.blocks.get(cId);
      if (c && c.atRange && c.atRange.length === 2) {
        if (c.atRange[0] < atMin) atMin = c.atRange[0];
        if (c.atRange[1] > atMax) atMax = c.atRange[1];
      }
    }
    const atRange = isFinite(atMin) && isFinite(atMax) ? [atMin, atMax] : null;

    const ev = { k: 'promote', parent, children, srcTok, sumTok, tier,
      ...(atRange ? { atRange } : {}) };
    this.store.append(ev);
    this._apply(ev);
    return ev;
  }

  // M4.1：等价极简事件流 = 活跃 msg（原序）+ 全部 fold（重建块）+ 全部 promote（重建层级）。
  // 已折叠/已驱逐消息的 msg 事件可安全丢弃：原文在块 raw 文件里永远可达（原文可达不变式）。
  _compactionEvents() {
    const out = [];
    for (const m of this.getActiveMessages()) out.push({ ...m });
    // v0.7.7 P1-7(D)：单趟扫描建 blockId→[min,max] 映射——原 O(消息×块) 嵌套在
    // 10 万消息 × 1 千块 = 1 亿次迭代，长会话 turn/end 撞阈值那轮会卡停宿主事件循环。
    const spanByBlock = new Map();
    for (const m of this.messages.values()) {
      if (m.status !== 'folded' || typeof m.ev.seq !== 'number' || !m.blockId) continue;
      const cur = spanByBlock.get(m.blockId);
      if (!cur) spanByBlock.set(m.blockId, [m.ev.seq, m.ev.seq]);
      else { if (m.ev.seq < cur[0]) cur[0] = m.ev.seq; if (m.ev.seq > cur[1]) cur[1] = m.ev.seq; }
    }
    for (const b of this.blocks.values()) {
      // v0.7.6 P0(C1)：promote 虚拟父块 range=null 且无 ids——fold 事件不可重放
      // （replay 旧语义解构 null 崩溃 → 0000 卷砖化 → 重启全会话离线）。层级由 promote 事件重建。
      if (b.range == null && !b.ids) continue;
      const span = spanByBlock.get(b.id) ?? (b.seqSpan ?? null); // v0.6.12 审计增强
      out.push({ k: 'fold', block: b.id, tier: b.tier, range: b.range, srcTok: b.srcTok, sumTok: b.sumTok, rawRef: b.rawRef,
        ...(b.ids ? { ids: b.ids } : {}), ...(span ? { seqSpan: span } : {}), ...(b.atRange ? { atRange: b.atRange } : {}), ...(b.note ? { note: b.note } : {}) });
    }
    for (const b of this.blocks.values()) {
      if (b.children && b.children.length > 0) {
        out.push({ k: 'promote', parent: b.id, children: b.children, srcTok: b.srcTok, sumTok: b.sumTok, tier: b.tier,
          ...(b.atRange ? { atRange: b.atRange } : {}) });
      }
    }
    return out;
  }

  compactNow() {
    // v0.7.7 P1-7(D)：内存计数，砍掉一次全量重放（store.replay 全量读盘只为数个数）
    const before = this._lastReplayEventCount + this._appendsSinceCompact;
    const events = this._compactionEvents();
    this.store.compact(events);
    this.messages.clear();
    this.blocks.clear();
    this.degraded.length = 0;
    this._replay();
    this._appendsSinceCompact = 0;
    return { before, after: events.length };
  }

  setPendingCompress(blockId) { this.pendingCompress = blockId; }

  getActiveMessages() {
    const out = [];
    for (const m of this.messages.values()) if (m.status === 'active') out.push(m.ev);
    // v0.6.34（外部用户报告）：按 (at, id) 时间序返回——此前按 id 字典序，UUID 下时间相邻
    // 的消息在字典序里随机散布，compress 的 range 解析（在 activeMsgs 里 findIndex 端点）
    // 约 50% 概率「起点在终点之后」报区间无效，另 50% 切出散乱错集（静默错折）。
    // nudge 候选区间、手动 range、指纹 first/last 全部回归时间语义。
    return out.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  getBlock(id) { return this.blocks.get(id); }
  listBlocks() { return [...this.blocks.values()]; }
  getLeafBlocks() { return [...this.blocks.values()].filter((b) => !b.promotedInto); }

  assertInvariants() {
    const activeTok = this.getActiveMessages().reduce((s, m) => s + m.tok, 0);
    const leafTok = this.getLeafBlocks().reduce((s, b) => s + b.srcTok, 0);
    const totalTok = activeTok + leafTok;

    for (const [id, m] of this.messages) {
      if (m.status === 'folded') {
        if (!m.blockId) throw new InvariantError('归属唯一', `消息 ${id} folded 但无 blockId`);
        if (!this.blocks.has(m.blockId)) throw new InvariantError('归属唯一', `消息 ${id} 属于不存在的块 ${m.blockId}`);
      }
    }

    if (this.pendingCompress !== null && !this.blocks.has(this.pendingCompress)) {
      this._degrade('pending-without-block');
    }

    for (const b of this.blocks.values()) {
      if (b.children && b.children.length > 0) continue;
      if (!b.rawRef) throw new InvariantError('原文可达', `块 ${b.id} 缺 rawRef`);
    }

    return { activeTok, leafTok, totalTok, blocks: this.blocks.size, messages: this.messages.size };
  }
}// CANARY-PWSH-2043674422
