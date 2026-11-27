// src/store.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, readdirSync, renameSync, openSync, readSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// v0.8.5 P2-13：canonical/hashCanonical 已删（snapshot 死代码的伴生，仅测试用过）

const SEG_RE = /^ledger\.(\d{4})\.jsonl$/;

export class Store {
  constructor({ dir, snapshotBudget = 1000, segBytes = 100 * 1024 * 1024, blockMaxBytes = 4 * 1024 * 1024, onWarn, readOnly = false } = {}) {
    this.dir = dir;
    this.readOnly = readOnly; // v0.8.0 根锁：只读降级实例（append/compact 拒绝写入）
    this.snapshotBudget = snapshotBudget;
    this.segBytes = segBytes;
    this.blockMaxBytes = blockMaxBytes;
    this.onWarn = onWarn ?? ((msg) => console.warn(`[wanjuan/store] ${msg}`));
    this.degraded = [];
    this._degradedWarned = false;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // v0.7.7 P2-7(D)：清扫崩溃残留的 tmp 文件（>1 小时）——只读实例不扫（不写共享目录）
    if (!this.readOnly) try {
      for (const f of readdirSync(this.dir)) {
        if (!/\.tmp/.test(f)) continue;
        try { if (Date.now() - statSync(join(this.dir, f)).mtimeMs > 3600 * 1000) unlinkSync(join(this.dir, f)); } catch {}
      }
    } catch {}
    this._syncSegIndex();
  }

  _syncSegIndex() {
    const files = readdirSync(this.dir).filter((f) => SEG_RE.test(f)).sort();
    this.segIndex = files.length === 0 ? 1 : Number(files[files.length - 1].match(SEG_RE)[1]);
  }

  _segPath(i) { return join(this.dir, `ledger.${String(i).padStart(4, '0')}.jsonl`); }
  _currentSegPath() { return this._segPath(this.segIndex); }
  _currentSegSize() { const p = this._currentSegPath(); return existsSync(p) ? statSync(p).size : 0; }

  _rotateIfNeeded(nextBytes) {
    if (this._currentSegSize() === 0) return;
    if (this._currentSegSize() + nextBytes <= this.segBytes) return;
    this.segIndex += 1;
  }

  append(ev) {
    // v0.8.0 根锁：只读实例拒绝写入（loud——上层 catch 会记日志，账本保持装载态快照）
    if (this.readOnly) throw new Error('wanjuan: 只读实例拒绝写入（根目录锁被其他进程持有）');
    const line = JSON.stringify(ev) + '\n';
    this._rotateIfNeeded(Buffer.byteLength(line));
    // v0.6.14：崩溃半行隔离——强杀可能留下无换行符的半行 JSON，若直接追加，
    // 新事件会与半行拼成一行，一坏坏俩。首次追加时检查文件尾字节，非 \n 先补一个，
    // 把半行隔离成独立坏行（replay 的 try/catch 只丢它一条）。每实例仅查一次。
    if (this._tailChecked === undefined) {
      this._tailChecked = true;
      try {
        const cur = this._currentSegPath();
        if (existsSync(cur)) {
          const st = statSync(cur);
          if (st.size > 0) {
            const fd = openSync(cur, 'r');
            try {
              const buf = Buffer.alloc(1);
              readSync(fd, buf, 0, 1, st.size - 1);
              if (buf[0] !== 0x0A) appendFileSync(cur, '\n', 'utf8');
            } finally { closeSync(fd); }
          }
        }
      } catch {}
    }
    appendFileSync(this._currentSegPath(), line, 'utf8');
    return ev;
  }

  // 坏行跳过不拖垮账本；首次发现坏行 warn 一次，让运维知道
  replay() {
    const files = readdirSync(this.dir).filter((f) => SEG_RE.test(f)).sort();
    const events = [];
    this.degraded = []; // v0.6.19：每次 replay 重置（此前坏行记录跨次累积膨胀）
    for (const f of files) {
      const text = readFileSync(join(this.dir, f), 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          // v0.7.6 P1(C1)：合法 JSON 但非对象（null / 数字 / 字符串）——_reduce 读 ev.k 会崩，
          // 构造函数无捕获 → 全会话离线。记 degraded 跳过，与 parse-error 同等宽容。
          if (ev === null || typeof ev !== 'object') { this.degraded.push({ file: f, line: i + 1, reason: 'malformed-line' }); continue; }
          events.push(ev);
        } catch (e) {
          this.degraded.push({ file: f, line: i + 1, reason: 'json-parse-error' });
        }
      }
    }
    if (this.degraded.length > 0 && !this._degradedWarned) {
      this._degradedWarned = true;
      this.onWarn(`账本有 ${this.degraded.length} 行损坏，已跳过。详情: ${JSON.stringify(this.degraded)}`);
    }
    return this._reduce(events);
  }

  _reduce(events) {
    const messages = [];
    const blocks = new Map();
    const evicted = new Set();
    const mutated = new Map();

    for (const ev of events) {
      if (ev.k === 'msg') messages.push(ev);
      else if (ev.k === 'mut') mutated.set(ev.id, ev);
      else if (ev.k === 'fold') blocks.set(ev.block, ev);
      // v0.7.6 P1(C1)：形状非法事件（缺 ids/children）不得在 _reduce 抛错——构造函数无捕获。
      else if (ev.k === 'evict') { if (Array.isArray(ev.ids)) for (const id of ev.ids) evicted.add(id); }
      else if (ev.k === 'promote') {
        if (Array.isArray(ev.children)) for (const c of ev.children) { const b = blocks.get(c); if (b) b.promotedInto = ev.parent; }
      }
    }
    return { events, messages, blocks, evicted, mutated };
  }

  // v0.8.5 P2-13：buildSnapshot/loadSnapshot 已删（生产零接线，M4.3 摊销压缩以更简
    // 方式覆盖；裸写 snapshot.json 曾是故障清单盲区——删除优于预留）

  writeBlock(id, obj) {
    const text = JSON.stringify(obj);
    const bytes = Buffer.byteLength(text);
    if (bytes > this.blockMaxBytes) {
      const err = new Error(`块 ${id} 尺寸 ${bytes} 超过上限 ${this.blockMaxBytes}`);
      err.code = 'BLOCK_TOO_LARGE';
      throw err;
    }
    // v0.8.3 R1a（故障注入 F2）：裸 writeFileSync 撕裂即半截 JSON——readBlockMeta 抛错、
    // search 静默吞块。与 writeRaw 同款：tmp+fsync+rename。
    const target = join(this.dir, `block.${id}.json`);
    const tmp = join(this.dir, `block.${id}.json.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, text, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
    return bytes;
  }

  // M4.1 对数压缩：把等价极简事件流写为 ledger.0000.jsonl（排序最前，replay 语义零改动），
  // 其余卷移入 archive/（原文永不删除）。月度会话的启动重放延迟从此有界。
  compact(events) {
    // v0.8.0 根锁：只读实例拒绝重写 0000 卷（会与持锁实例的账本分裂）
    if (this.readOnly) throw new Error('wanjuan: 只读实例拒绝对数压缩（根目录锁被其他进程持有）');
    const body = events.map((ev) => JSON.stringify(ev) + '\n').join('');
    // v0.7.6 P0-1(C2)：原子重写——裸 writeFileSync 先截断后写，崩溃撕裂即账本损坏，
    // 默认 100MB 单卷下 archive 为空、无副本可恢复。与 writeRaw 同款：tmp+fsync+rename。
    const target = this._segPath(0);
    const tmp = join(this.dir, `ledger.0000.jsonl.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, body, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
    // v0.6.15 P0-6：每次压缩独立时间戳子目录——Windows renameSync 目标存在即抛
    // EEXIST，旧方案二次压缩必现并无限失败循环；新方案重名根除，且各次归档互不混淆
    const adir = join(this.dir, 'archive', String(Date.now()));
    if (!existsSync(adir)) mkdirSync(adir, { recursive: true });
    // v0.8.0 增量①（复审冻结项）：归档顺序不能依赖 readdir 的隐式字母序（NTFS 惯例而非契约）
    for (const f of readdirSync(this.dir).filter((x) => SEG_RE.test(x) && x !== 'ledger.0000.jsonl').sort()) {
      renameSync(join(this.dir, f), join(adir, f));
    }
    this._syncSegIndex();
    return events.length;
  }

  hasDegraded() { return this.degraded.length > 0; }
  getDegraded() { return [...this.degraded]; }
}