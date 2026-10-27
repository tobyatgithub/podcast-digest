#!/usr/bin/env node
// validate-episode.mjs — podcast-digest 输出文件硬校验
// 用法: node scripts/validate-episode.mjs <episode.md 或目录...>
// 每条规则都对应一次真实事故（见行内注释），不是想象的防御。退出码非 0 = 有错误。
// 依赖: npm install（js-yaml）

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// duration 字段 "91 min" / "60 min" → 秒；解析失败返回 null（时长类检查跳过）
function durationSec(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/(\d+(?:\.\d+)?)\s*min/i);
  return m ? parseFloat(m[1]) * 60 : null;
}

// 深度遍历找 null 值，返回路径列表
function findNulls(obj, prefix = '') {
  const hits = [];
  if (obj === null) hits.push(prefix || '(root)');
  else if (Array.isArray(obj)) obj.forEach((v, i) => hits.push(...findNulls(v, `${prefix}[${i}]`)));
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) hits.push(...findNulls(v, prefix ? `${prefix}.${k}` : k));
  return hits;
}

function validate(file) {
  const errors = [];
  const warns = [];
  const rel = path.relative(process.cwd(), file);
  const raw = fs.readFileSync(file, 'utf8');

  // 规则1: frontmatter 边界 —— 开头 ---，结尾必须是独占一行的 ---
  // 事故: 组装时 --- 粘在 transcript 内容末尾导致整文件解析失败
  const m = raw.match(/^---\n([\s\S]*?)\n---\s*$/);
  if (!m) {
    return { rel, errors: ['frontmatter 边界不合法：文件必须以 --- 行开始、以独占一行的 --- 结束（不能粘在内容末尾）'], warns };
  }

  // 规则2: YAML 可解析
  let doc;
  try {
    doc = yaml.load(m[1]);
  } catch (e) {
    return { rel, errors: [`YAML 解析失败: ${e.message}`], warns };
  }

  // 规则3: date 必须是引号字符串（未加引号会被 YAML 解析成 Date 对象，下游 schema 校验行为不可控）
  if (!(typeof doc.date === 'string')) errors.push(`date 不是引号字符串（当前类型: ${doc.date?.constructor?.name ?? typeof doc.date}）— 写成 date: "YYYY-MM-DD"`);

  // 规则4: 全树无 null（很多下游 schema 对 optional number 不接受 null，写过 comments: null 直接 build 崩）
  const nulls = findNulls(doc);
  if (nulls.length) errors.push(`存在 null 值（可选字段没值就直接省略）: ${nulls.slice(0, 5).join(', ')}${nulls.length > 5 ? ` …共${nulls.length}处` : ''}`);

  // 规则6: chapters 只允许 time/title —— 多余键（如 titleZh）会被严格 schema 静默剥离，作者永远不知道没生效
  for (const [i, c] of (doc.chapters ?? []).entries()) {
    const extra = Object.keys(c).filter((k) => !['time', 'title'].includes(k));
    if (extra.length) errors.push(`chapters[${i}] 有会被静默剥离的多余键: ${extra.join(', ')}（schema 只接受 time/title）`);
  }

  // 规则7: transcript 时间数学 —— offset + 段内时间不得超过总时长；绝对时间戳 + 非零 offset 直接判死
  // 事故: parse_subtitles.py 输出绝对时间戳却写 offset:1800，前端渲染时间全部翻倍
  const dur = durationSec(doc.duration);
  const blocks = Array.isArray(doc.transcript) ? doc.transcript : [];
  blocks.forEach((b, i) => {
    const segs = b.segments ?? [];
    if (typeof b.offset !== 'number') { errors.push(`transcript[${i}].offset 不是数字`); return; }
    if (dur && segs.length && b.offset + segs[0].start > dur + 120) errors.push(`transcript[${i}]: offset(${b.offset}) + 首段 start(${segs[0].start}s) 已超出视频时长 ${dur}s —— 若段内是绝对时间戳，offset 必须为 0`);
    const maxEnd = segs.reduce((a, s) => Math.max(a, s.end ?? 0), 0);
    if (dur && b.offset + maxEnd > dur + 120) errors.push(`transcript[${i}]: offset(${b.offset}) + 段内最大 end(${maxEnd}s) = ${b.offset + maxEnd}s 超出视频时长 ${dur}s（+120s 余量）`);
    for (const [j, s] of segs.entries()) {
      if (s.start > s.end) errors.push(`transcript[${i}].segments[${j}]: start(${s.start}) > end(${s.end})`);
      else if (s.start === s.end) warns.push(`transcript[${i}].segments[${j}]: 零长段 start==end(${s.start})，疑似 VTT 空行解析残留（不影响渲染，可择机清理）`);
    }
  });

  // 规则8: 英文素材的双语契约 —— 每句必须有非空 translation；title/summary/highlights 必须有 Zh 对
  if (doc.language === 'en') {
    if (!doc.titleZh) errors.push('language=en 但缺 titleZh');
    if (!doc.summaryZh) errors.push('language=en 但缺 summaryZh');
    let missingTr = 0;
    blocks.forEach((b, i) => (b.segments ?? []).forEach((s, j) => { if (!s.translation || !String(s.translation).trim()) { missingTr++; if (missingTr <= 3) errors.push(`transcript[${i}].segments[${j}] 缺 translation（1:1 翻译不完整）`); } }));
    if (missingTr > 3) errors.push(`…共 ${missingTr} 段缺 translation`);
    // 规则8b: 翻译完整性的启发式 —— 中文字数/英文词数 正常约 1.5-2.5；显著偏低 = 疑似截断漏译
    // 事故: 2026-08-27 skill-eval 实测，末段翻译截断 60% 仍通过"非空"检查，并静默传导进 summary/quotes
    blocks.forEach((b, i) => (b.segments ?? []).forEach((s, j) => {
      const enWords = String(s.text ?? '').trim().split(/\s+/).filter(Boolean).length;
      const zhChars = String(s.translation ?? '').replace(/\s/g, '').length;
      if (enWords >= 6 && zhChars / enWords < 0.9) warns.push(`transcript[${i}].segments[${j}]: 翻译疑似截断（中文${zhChars}字/英文${enWords}词，比值${(zhChars / enWords).toFixed(2)}，正常约1.5-2.5）`);
    }));
    (doc.highlights ?? []).forEach((h, i) => { if (!h.contentZh) errors.push(`highlights[${i}] 缺 contentZh`); });
    (doc.quotes ?? []).forEach((q, i) => { if (!q.textZh) errors.push(`quotes[${i}] 缺 textZh`); });
  }

  // 规则9(软): 中文素材带 translation 字段属于冗余（不报错，提醒）
  if (doc.language === 'zh') {
    blocks.forEach((b, i) => (b.segments ?? []).forEach((s) => { if (s.translation) { warns.push(`transcript 含 translation 字段但 language=zh（中文素材惯例不翻译）`); } }));
  }

  // 规则10: 结构化数组 entry 形状 —— 防"漏键行导致数组被吞进前一个 key"
  // 事故: 漏写 transcript: 键行，transcript chunks 被 YAML 并进 chapterDetails，直到 build 时才炸
  const SHAPES = {
    highlights: ['title', 'content'],
    quotes: ['speaker', 'text'],
    takeaways: ['title', 'content'],
    chapterDetails: ['time', 'title', 'content'],
    topics: ['keyword', 'description'],
  };
  for (const [key, required] of Object.entries(SHAPES)) {
    (Array.isArray(doc[key]) ? doc[key] : []).forEach((e, i) => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) { errors.push(`${key}[${i}] 不是对象`); return; }
      for (const k of required) {
        if (!e[k] || !String(e[k]).trim()) errors.push(`${key}[${i}] 缺 ${k} —— 若该 entry 带的是 offset/segments 之类异类键，多半是漏了某个数组的键行、两个数组被 YAML 吞并了`);
      }
    });
  }

  // 规则11(软): thesis 缺失提醒 —— 每条亮点应带一句话论点（渲染成章首引文块），存量未修缮的集会告警
  (doc.highlights ?? []).forEach((h, i) => {
    if (!h.thesis || !String(h.thesis).trim()) warns.push(`highlights[${i}]「${(h.title || '').slice(0, 20)}」缺 thesis（排版规范：一句话论点，AI 从逐字稿蒸馏）`);
  });

  if (!Array.isArray(doc.keywords) || !doc.keywords.length) errors.push('keywords 为空');

  return { rel, errors, warns };
}

// ---- main ----
let files = process.argv.slice(2).map((f) => path.resolve(f));
if (!files.length) {
  console.error('用法: node scripts/validate-episode.mjs <episode.md 或目录...>');
  process.exit(1);
}
// 目录参数展开
files = files.flatMap((f) => (fs.statSync(f).isDirectory() ? fs.readdirSync(f).filter((x) => x.endsWith('.md')).map((x) => path.join(f, x)) : [f]));

let bad = 0;
for (const f of files) {
  const { rel, errors, warns } = validate(f);
  if (errors.length) {
    bad++;
    console.log(`✗ ${rel}`);
    for (const e of errors) console.log(`    ERROR ${e}`);
  } else {
    console.log(`✓ ${rel}${warns.length ? `  (${warns.length} 条提醒)` : ''}`);
    for (const w of [...new Set(warns)].slice(0, 3)) console.log(`    warn  ${w}`);
  }
}
console.log(`\n${files.length - bad}/${files.length} 通过`);
process.exit(bad ? 1 : 0);
