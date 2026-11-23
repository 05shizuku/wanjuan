// src/lock.mjs — v0.8.0 第一批（根锁）：插件级 LockManager
// 目的：同一根目录被第二个实例（进程/热重载）打开时，后到者降级只读——双写撕裂在入口处根绝。
// 设计（第二轮复审冻结，2026-11-23）：
//   1. 锁生命周期收归插件级——Store 每会话一个，锁放 Store 构造函数里第二个会话会把自己锁死；
//   2. 独占创建用 'wx'（Windows CREATE_NEW / POSIX O_EXCL，原子原语）——这正是项目在
//      host-bridge.json / owner.json / calib.json 上依赖的同一可靠性家族；
//   3. 半截锁文件先等再读；无法确认持有者死亡时宁可只读；
//   4. 不做双槽指针（复审 pushback：renameSync+REPLACE_EXISTING 已是原子原语，
//      双槽引入新状态机和新失败模式而非可靠性——CURRENT 单槽 + 损坏回退扫描留给代际批）。
import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_NAME = 'wanjuan.lock';

function _sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); return; } catch {}
  const until = Date.now() + ms;
  while (Date.now() < until) {}
}

export class LockManager {
  constructor({ dir, bootId = '', onWarn = () => {}, readRetryMs = 200, readRetry = 3 } = {}) {
    this.dir = dir;
    this.bootId = bootId;
    this.onWarn = onWarn;
    this.readRetryMs = readRetryMs; // 测试可注入
    this.readRetry = readRetry;
    this.path = join(dir ?? '.', LOCK_NAME);
    this.acquired = false;
    this.readOnly = false;
    this.holder = null;
    this.reason = '';
    this._exitHooked = false;
  }

  acquire() {
    if (!this.dir) { this.readOnly = true; this.reason = 'no-dir'; return this; }
    for (let attempt = 0; attempt <= this.readRetry; attempt++) {
      // 独占创建：存在即失败（EEXIST），无截断窗口
      let fd = null;
      try {
        fd = openSync(this.path, 'wx');
        try {
          writeSync(fd, JSON.stringify({ pid: process.pid, boot: this.bootId, at: Date.now() }));
        } finally {
          closeSync(fd);
        }
        this.acquired = true;
        this.readOnly = false;
        this.reason = '';
        this._hookExit();
        return this;
      } catch (e) {
        if (fd !== null) { try { closeSync(fd); } catch {} }
        if (!e || e.code !== 'EEXIST') {
          this.readOnly = true;
          this.reason = `lock-create-failed: ${e?.message ?? e}`;
          this.onWarn(`[wanjuan] 根锁创建失败（${this.reason}）——进入只读`);
          return this;
        }
      }
      // 锁已存在：读持有者（半截文件先等再读）
      const holder = this._readHolder();
      if (holder === 'unreadable') {
        this.readOnly = true;
        this.reason = 'lock-unreadable';
        this.onWarn('[wanjuan] 根锁存在但无法读取（疑似半截写入）——无法确认持有者死亡，宁可只读');
        return this;
      }
      if (holder && this._pidAlive(holder.pid)) {
        this.readOnly = true;
        this.holder = holder;
        this.reason = 'held-by-live-process';
        this.onWarn(`[wanjuan] 根目录锁被进程 ${holder.pid} 持有（boot ${holder.boot || '?'}，约 ${Math.round((Date.now() - (holder.at || Date.now())) / 60000)} 分钟前获取）——本实例降级只读`);
        return this;
      }
      // 持有者已死（pid 不存在）或锁内容是垃圾：删除后重试独占创建
      // （双进程竞争同一把死锁时，'wx' 保证只有一方拿到，另一方回到读持有者分支 → 只读）
      try { unlinkSync(this.path); } catch {}
      _sleep(30);
    }
    this.readOnly = true;
    this.reason = 'lock-contention-unresolved';
    this.onWarn('[wanjuan] 根锁竞争未解决——本实例降级只读');
    return this;
  }

  _readHolder() {
    for (let i = 0; i < this.readRetry; i++) {
      try {
        const j = JSON.parse(readFileSync(this.path, 'utf8'));
        return (j && typeof j.pid === 'number') ? j : null; // 可读但形状不对：视为陈旧垃圾（无持有者）
      } catch {
        _sleep(this.readRetryMs); // 半截：等写入方写完再读
      }
    }
    return 'unreadable';
  }

  _pidAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }

  _hookExit() {
    if (this._exitHooked) return;
    this._exitHooked = true;
    process.on('exit', () => {
      try { if (this.acquired) unlinkSync(this.path); } catch {}
    });
  }
}
