// src/tokenizer.mjs
// 万卷统一 Token 估算口径（M5.4 抽离）。
// CJK 1.2 / 其他 0.25——入账、sumTok、nudge 消息 tok 的唯一口径。
//
// 背景：v0.6.16 起 dsh.mjs 已用 1.2，但 nudge.mjs 仍是 1.0（系统性低估约 17%）。
// 本模块统一为 1.2，消除口径分裂（DESIGN §3.2「一个口径原则」）。
//
// 迭代方式选 charCodeAt 而非 for...of：
//   宿主 CJK 都在 BMP 内，两种迭代对 CJK 计数一致；
//   但代理对（emoji 等）charCodeAt 拆成两个 other（0.5），for...of 只算一个（0.25）。
//   charCodeAt 更保守（偏大），对水位预测是"偏早折叠"的安全方向。

function _estimateString(s) {
  let cjk = 0, other = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fa5) cjk++;
    else other++;
  }
  return Math.max(1, Math.ceil(cjk * 1.2 + other * 0.25));
}

/**
 * 估算 content 的 token 数。支持三种形态：
 *   1. string：按字符估算
 *   2. ContentBlock[]：拼接 text 与 tool-call 的 name+arguments 后估算
 *   3. 其他（null/undefined/空串）：返回 1（最小非零值）
 */
export function estimateTok(content) {
  if (typeof content === 'string' && content.length > 0) {
    return _estimateString(content);
  }
  if (Array.isArray(content)) {
    let text = '';
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (typeof b.text === 'string') text += b.text;
      else if (b.type === 'tool-call') text += (b.name ?? '') + (b.arguments ?? '');
    }
    return _estimateString(text);
  }
  return 1;
}
