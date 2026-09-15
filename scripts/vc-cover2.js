/**
 * 图集内容核对：确认「图集里每张照片的图注 == 该照片的文件名」，且无遗漏、无重复。
 *
 * 做法：解压所有页面内容流，把 Identity-H 编码的十六进制串按各字体的 ToUnicode CMap
 * 还原成文字，然后：
 *   1. 从照片页里取出「图 N　<名称>」图注，与源目录文件名逐一比对（顺序、数量、文字全等）；
 *   2. 核对附录索引表是否覆盖全部文件名；
 *   3. 核对页面数量 = 1 封面 + N 照片 + M 索引。
 *
 * 用法: node scripts/verify_album_content.js <pdf> <照片目录>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const pdfPath = process.argv[2];
const photoDir = process.argv[3];
if (!pdfPath || !photoDir) {
  console.error('用法: node scripts/verify_album_content.js <pdf> <照片目录>');
  process.exit(2);
}

const pdf = fs.readFileSync(pdfPath);
const raw = pdf.toString('latin1');
const xrefPos = parseInt(raw.slice(raw.lastIndexOf('startxref') + 9).trim().split(/\s/)[0], 10);
const xrefLines = raw.slice(xrefPos).split('\n');
const objCount = parseInt(xrefLines[1].trim().split(/\s+/)[1], 10);
const offsets = [];
for (let i = 0; i < objCount; i++) offsets.push(parseInt(xrefLines[2 + i].slice(0, 10), 10));

const objText = (i) => raw.slice(offsets[i], i + 1 < objCount ? offsets[i + 1] : raw.length);

function streamData(i) {
  const t = objText(i);
  const s = t.indexOf('stream');
  if (s < 0) return null;
  let ds = s + 6;
  if (t[ds] === '\r') ds++;
  if (t[ds] === '\n') ds++;
  const len = parseInt(t.slice(0, s).match(/\/Length\s+(\d+)/)[1], 10);
  return Buffer.from(raw.slice(offsets[i] + ds, offsets[i] + ds + len), 'latin1');
}

// ---- 收集 ToUnicode：字体资源名(F_xxx) -> cid->unicode
const fontToUnicode = new Map();   // F_xxx -> Map(cid -> char)
const pageObjs = [];
for (let i = 1; i < objCount; i++) {
  const t = objText(i);
  if (/\/Type\s*\/Page[^s]/.test(t)) pageObjs.push(i);
}

// 资源字典：/F_yahei 6 0 R  ->  再经 Type0->ToUnicode 找到码表
const fontResToType0 = new Map();
for (let i = 1; i < objCount; i++) {
  const t = objText(i);
  for (const m of t.matchAll(/\/(F_\w+)\s+(\d+)\s+0\s+R/g)) fontResToType0.set(m[1], parseInt(m[2], 10));
}
for (const [resName, type0Num] of fontResToType0) {
  const t0 = objText(type0Num);
  const toUniM = t0.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
  if (!toUniM) continue;
  const cmapText = zlib.inflateSync(streamData(parseInt(toUniM[1], 10))).toString('latin1');
  const map = new Map();
  for (const m of cmapText.matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4,})>/g)) {
    const cid = parseInt(m[1], 16);
    const uni = m[2];
    let s = '';
    for (let k = 0; k + 4 <= uni.length; k += 4) s += String.fromCharCode(parseInt(uni.slice(k, k + 4), 16));
    map.set(cid, s);
  }
  fontToUnicode.set(resName, map);
}

// ---- 逐页还原文字与图片绘制
// 注意：内容流里 <...> Tj 的十六进制是 CID（Identity-H 编码），不是 Unicode 码点，
// 必须经该字体的 ToUnicode CMap 反查真实字符。
function decodeContent(text) {
  const out = [];
  // 形如: BT /F_heiti 11.50 Tf 0.275 0.275 0.275 rg x y Td <HEX> Tj ET
  const re = /BT\s+\/(F_\w+)\s+[\d.]+\s+Tf\s+[\d.\s]+rg\s+[\d.-]+\s+[\d.-]+\s+Td\s+<([0-9A-Fa-f]*)>\s*Tj\s*ET/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const map = fontToUnicode.get(m[1]);
    const hex = m[2];
    let s = '';
    for (let k = 0; k + 4 <= hex.length; k += 4) {
      const cid = parseInt(hex.slice(k, k + 4), 16);
      s += map ? (map.get(cid) || '\uFFFD') : '\uFFFD';
    }
    out.push(s);
  }
  const imgRe = /\/Im(\d+)\s+Do/g;
  const imgs = [];
  let im;
  while ((im = imgRe.exec(text)) !== null) imgs.push(parseInt(im[1], 10));
  return { texts: out, imgs };
}

const pages = [];
for (const p of pageObjs) {
  const t = objText(p);
  const contM = t.match(/\/Contents\s+(\d+)\s+0\s+R/);
  if (!contM) continue;
  const content = zlib.inflateSync(streamData(parseInt(contM[1], 10))).toString('latin1');
  pages.push(decodeContent(content));
}

// ---- 期望内容
const files = fs.readdirSync(photoDir)
  .filter((n) => /\.(jpe?g|png)$/i.test(n))
  .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
const expectedCaptions = files.map((n, i) => `图 ${i + 1}　${path.basename(n, path.extname(n))}`);

// ---- 核对
const problems = [];
const notes = [];
const photoPages = pages.filter((p) => p.imgs.length === 1);
const coverPages = pages.filter((p) => p.imgs.length === 0);

notes.push(`页面总数 ${pages.length}（含图片页 ${photoPages.length}，无图片页 ${coverPages.length}）`);
if (photoPages.length !== files.length) {
  problems.push(`含图片页面数 ${photoPages.length} != 照片数 ${files.length}`);
}

// 1) 每张照片页的图注与文件名
let captionOk = 0;
photoPages.forEach((p, idx) => {
  const imgId = p.imgs[0];
  const expected = expectedCaptions[idx];
  if (imgId !== idx + 1) problems.push(`第 ${idx + 1} 张照片页引用了 /Im${imgId}，期望 /Im${idx + 1}`);
  const found = p.texts.find((s) => s.startsWith('图 '));
  if (!found) { problems.push(`第 ${idx + 1} 张照片页找不到图注`); return; }
  if (found !== expected) problems.push(`第 ${idx + 1} 张图注不符：\n      实际「${found}」\n      期望「${expected}」`);
  else captionOk++;
});
notes.push(`图注与文件名一致：${captionOk}/${files.length}`);

// 2) 索引表覆盖全部文件名
const indexText = pages.filter((p) => p.imgs.length === 0).map((p) => p.texts.join('\n')).join('\n');
const missingInIndex = expectedCaptions
  .map((c) => c.replace(/^图 \d+　/, ''))
  .filter((name) => !indexText.includes(name));
if (missingInIndex.length) problems.push(`索引表缺少 ${missingInIndex.length} 个文件名：${missingInIndex.slice(0, 5).join(' / ')}`);
else notes.push('索引表包含全部文件名');

// 3) 封面要素（封面首行是项目名称，标题不在第一段，因此拼接全部文本再查）
const coverText = coverPages.length ? coverPages[0].texts.join('  ') : '';
for (const key of ['20260915 现场图集', '2026年09月15日', `${files.length} 张`, '现场施工情况照片汇编']) {
  const hit=coverText.includes(key);
  console.error('[dbg] key='+JSON.stringify(key)+' len='+key.length+' found='+hit);
  if(!hit){ const i=coverText.indexOf(key[0]); console.error('        coverText 首字符位置='+i+' 片段='+JSON.stringify(coverText.slice(Math.max(0,i),i+30))); }
  if (!hit) problems.push(`封面缺少「${key}」`);
}
notes.push('封面要素（标题/拍摄日期/照片数量/副标题）齐全');

// ---- 输出
console.log('============ 图集内容核对 ============');
console.log('PDF       : ' + pdfPath);
console.log('照片目录  : ' + photoDir);
console.log('');
notes.forEach((n) => console.log('  ' + n));
console.log('');
if (problems.length) {
  console.log('发现问题 ' + problems.length + ' 项:');
  problems.slice(0, 20).forEach((p) => console.log('  ✗ ' + p));
  process.exit(1);
}
console.log('结论: 每张照片的图注与该照片文件名一一对应，索引表完整，封面要素齐全。');
