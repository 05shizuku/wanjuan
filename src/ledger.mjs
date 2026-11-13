// src/ledger.mjs
// L1 账本层。事件溯源封装 Store，维护消息/块状态，做不变式检查。

export class InvariantError extends Error {
  constructor(name, detail) {
    super(`不变式 ${name} 违反：${detail}`);
    this.name = 'InvariantError';
    this.invariant = name;
  }
}

export class Ledger {
  constructor({ store }) {
    this.store = store;
    this.messages = new Map();
    this.blocks = new Map();
    this.pendingCompress = null;
    this.degraded = [];
    this._replay();
  }

  _replay() {
    const state = this.store.replay();
    for (const ev of state.events) this._apply(ev);
  }

  _apply(ev) {
    if (ev.k === 'msg') {
      if (!this.messages.has(ev.id)) this.messages.set(ev.id, { ev, status: 'active' });
    } else if (ev.k === 'fold') {
      const block = {
        id: ev.block, tier: ev.tier, range: ev.range,
        srcTok: ev.srcTok, sumTok: ev.sumTok,
        rawRef: ev.rawRef, note: ev.note,
        children: undefined, promotedInto: undefined,
      };
      this.blocks.set(ev.block, block);
      const [start, end] = ev.range;
      for (const [id, m] of this.messages) {
        if (id >= start && id <= end && m.status === 'active') {
          m.status = 'folded';
          m.blockId = ev.block;
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
        const [start, end] = b.range;
        for (const [id, m] of this.messages) {
          if (id >= start && id <= end && m.status === 'folded' && m.blockId === ev.block) {
            m.status = 'active';
            m.blockId = undefined;
          }
        }
        this.blocks.delete(ev.block);
      }
    } else if (ev.k === 'promote') {
      // 晋升 = 创建（或更新）tier-2/3 父块；父块不写新 raw，rawRef 为 null
      let parent = this.blocks.get(ev.parent);
      if (!parent) {
        parent = {
          id: ev.parent, tier: ev.tier, range: null,
          srcTok: ev.srcTok, sumTok: ev.sumTok,
          rawRef: null, note: undefined,
          children: undefined, promotedInto: undefined,
        };
        this.blocks.set(ev.parent, parent);
      }
      parent.children = ev.children;
      parent.srcTok = ev.srcTok;
      parent.sumTok = ev.sumTok;
      parent.tier = ev.tier;
      for (const c of ev.children) {
        const child = this.blocks.get(c);
        if (child) child.promotedInto = ev.parent;
      }
    }
  }

  _degrade(kind) { if (!this.degraded.includes(kind)) this.degraded.push(kind); }
  getDegraded() { return [...this.degraded]; }

  recordMsg({ id, at = 0, bytes = 0, tok = 0, cls = 'text', gen = 0 }) {
    const existing = this.messages.get(id);
    if (existing && existing.status === 'active') return existing.ev;
    const ev = { k: 'msg', id, at, bytes, tok, cls, gen };
    this.store.append(ev);
    this._apply(ev);
    return ev;
  }

  recordFold({ block, range, srcTok, sumTok, tier, rawRef, note }) {
    if (!rawRef) throw new InvariantError('原文可达', `fold ${block} 缺少 rawRef`);
    if (this.pendingCompress !== null && this.pendingCompress !== block) {
      throw new InvariantError('并发唯一', `已有未决 compress ${this.pendingCompress}`);
    }
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
    const ev = { k: 'fold', block, range, srcTok, sumTok, tier, rawRef, ...(note ? { note } : {}) };
    this.store.append(ev);
    this._apply(ev);
    this.pendingCompress = null;
    return ev;
  }

  recordUnfold({ block, why }) {
    if (!['context', 'file'].includes(why)) {
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
    const ev = { k: 'promote', parent, children, srcTok, sumTok, tier };
    this.store.append(ev);
    this._apply(ev);
    return ev;
  }

  setPendingCompress(blockId) { this.pendingCompress = blockId; }

  getActiveMessages() {
    const out = [];
    for (const m of this.messages.values()) if (m.status === 'active') out.push(m.ev);
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

    // 原文可达：叶子块必须有 rawRef；有 children 的父块靠 children 递归展开，rawRef 允许为 null
    for (const b of this.blocks.values()) {
      if (b.children && b.children.length > 0) continue;
      if (!b.rawRef) throw new InvariantError('原文可达', `块 ${b.id} 缺 rawRef`);
    }

    return { activeTok, leafTok, totalTok, blocks: this.blocks.size, messages: this.messages.size };
  }
}