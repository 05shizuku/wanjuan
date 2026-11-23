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

// v0.7.5 P1-2：递归提取文本——宿主块词汇 text/reasoning/image/tool-call/tool-result，
// tool-result 载荷在嵌套 content 数组、reasoning 载荷在 thinking 字段（此前漏算，
// 工具输出整条按 ~1 tok 入账——代理会话中最大的 token 类）
function extractText(blocks) {
  let out = '';
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (typeof b.text === 'string') out += b.text;
    else if (typeof b.thinking === 'string') out += b.thinking;
    else if (b.type === 'tool-call') out += (b.name ?? '') + (typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? '')); // v0.7.6 P2(C1)：object arguments 原拼接成 "[object Object]" 漏算
    else if (typeof b.content === 'string') out += b.content; // v0.7.6 P2(C1)：string 型 content——巨大工具载荷按 1 tok 入账的漏洞
    else if (Array.isArray(b.content)) out += extractText(b.content);
  }
  return out;
}

// v0.7.7 E1-P2-2：image 块计数（递归含嵌套 content）——纯图消息原按 1 tok 计
function countImages(blocks) {
  let n = 0;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'image') n++;
    else if (Array.isArray(b.content)) n += countImages(b.content);
  }
  return n;
}

function _estimateString(s) {
  // v0.7.7 P1-6(D)：区间表扩展——韩文/假名/CJK 扩展A/全角标点原按 0.25 计，
  // 系统性低估 → 水位偏晚折叠（危险方向：偏早才安全）。
  let weighted = 0, other = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)) weighted += 1.2; // 汉字/扩展A/CJK标点/全角
    else if (code >= 0x3040 && code <= 0x30ff) weighted += 1.2; // 假名
    else if (code >= 0xac00 && code <= 0xd7af) weighted += 2.0; // 谚文
    else other++;
  }
  return Math.max(1, Math.ceil(weighted + other * 0.25));
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
    // v0.7.7 E1-P2-2：image 块按常量 1100 tok/张计入（多模态水位系统性低估的补口）
    return _estimateString(extractText(content)) + countImages(content) * 1100;
  }
  return 1;
}
