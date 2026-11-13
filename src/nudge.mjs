// src/nudge.mjs
import { Philosophy } from './philosophy.mjs';

function estimateTok(content) {
  if (!content) return 0;
  let cjk = 0, other = 0;
  for (const ch of content) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.0 + other * 0.25);
}

export class NudgeManager {
  constructor({ philosophy = new Philosophy(), minSize = 10_000, tailKeepTok = 30_000 } = {}) {
    this.philosophy = philosophy;
    this.minSize = minSize;
    this.tailKeepTok = tailKeepTok;
    this.rangeStates = new Map();
  }

  findCandidates(activeMessages, { tailKeepTok } = {}) {
    const keep = tailKeepTok ?? this.tailKeepTok;

    // 修：tailKeepTok ≤ 0 时整段都当候选，不设尾部保留窗
    let tailStart = activeMessages.length;
    if (keep > 0) {
      const totalTok = activeMessages.reduce((s, m) => s + (m.tok || 0), 0);
      const actualKeep = Math.min(keep, totalTok);
      let tailAcc = 0;
      for (let i = activeMessages.length - 1; i >= 0; i--) {
        tailAcc += activeMessages[i].tok || 0;
        if (tailAcc >= actualKeep) { tailStart = i; break; }
      }
    }

    const candidates = [];
    let currentMsgs = [];
    let currentTok = 0;
    for (let i = 0; i < tailStart; i++) {
      const m = activeMessages[i];
      currentMsgs.push(m);
      currentTok += (m.tok || 0);
      if (currentTok >= this.minSize) {
        candidates.push({
          range: [currentMsgs[0].id, currentMsgs[currentMsgs.length - 1].id],
          msgCount: currentMsgs.length, srcTok: currentTok, topics: '',
        });
        currentMsgs = []; currentTok = 0;
      }
    }
    if (currentMsgs.length > 0 && currentTok > 0) {
      candidates.push({
        range: [currentMsgs[0].id, currentMsgs[currentMsgs.length - 1].id],
        msgCount: currentMsgs.length, srcTok: currentTok, topics: '',
      });
    }
    return candidates;
  }

  _key(range) { return `${range[0]}-${range[1]}`; }

  recordReject(range, turn) {
    const k = this._key(range);
    const state = this.rangeStates.get(k) || { rejects: 0, lastTurn: 0 };
    state.rejects += 1;
    state.lastTurn = turn;
    this.rangeStates.set(k, state);
  }

  recordAccept(range) { this.rangeStates.delete(this._key(range)); }

  shouldNudge(range, currentTurn) {
    const k = this._key(range);
    const state = this.rangeStates.get(k);
    if (!state) return true;
    if (state.rejects >= 3) {
      return (currentTurn - state.lastTurn) >= 3;
    }
    return true;
  }

  buildNudgeMessage(candidates, currentTurn) {
    const validCandidates = candidates.filter(c => this.shouldNudge(c.range, currentTurn));
    if (validCandidates.length === 0) return null;
    const text = this.philosophy.buildNudge({ candidates: validCandidates });
    return {
      id: `wj-nudge-${currentTurn}`,
      cls: 'sys',
      tok: estimateTok(text),
      content: text,
    };
  }
}