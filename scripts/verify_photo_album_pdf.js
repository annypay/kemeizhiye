/**
 * PDF 结构校验器：检查生成的图集 PDF 是否结构完整、可被解析器接受。
 *
 * 校验项：
 *   1. 文件头 / 文件尾 / startxref / xref 表；
 *   2. 每个对象的 xref 偏移是否精确指向 "N 0 obj"；
 *   3. /Pages /Count 与 /Kids 是否与实际 Page 对象数一致；
 *   4. 按 xref 逐对象解析，/Filter 流能否解压，/Length 是否精确；
 *   5. 内嵌 TrueType 子集结构（表目录、cmap、loca/glyf 一致性）；
 *   6. 内容流引用的字体与图像资源是否都已声明。
 *
 * 用法: node scripts/verify_photo_album_pdf.js <pdf 路径>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const file = process.argv[2];
if (!file) { console.error('用法: node scripts/verify_photo_album_pdf.js <pdf>'); process.exit(2); }

const buf = fs.readFileSync(file);
const raw = buf.toString('latin1');   // 字节位置 == 字符位置

// 可选：把内嵌字体子集导出到目录，供 GDI+ 等渲染器进一步校验
const dumpDir = process.env.PDF_FONT_DUMP || '';
if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });

const problems = [];
const notes = [];
const ok = (cond, msg) => { if (!cond) problems.push(msg); else notes.push('✓ ' + msg); };

// ---------------------------------------------------------------- 1. 头尾
ok(raw.startsWith('%PDF-'), 'PDF 文件头存在');
ok(raw.trimEnd().endsWith('%%EOF'), 'PDF 文件尾 %%EOF 存在');

const sxIdx = raw.lastIndexOf('startxref');
const xrefPos = parseInt(raw.slice(sxIdx + 9).trim().split(/\s/)[0], 10);
ok(Number.isFinite(xrefPos) && raw.slice(xrefPos, xrefPos + 4) === 'xref',
   `startxref 指向 xref 表（offset=${xrefPos}）`);

// ---------------------------------------------------------------- 2. xref 表
const xrefLines = raw.slice(xrefPos).split('\n');
const xrefHeader = xrefLines[1].trim().split(/\s+/);
const objCount = parseInt(xrefHeader[1], 10);
const offsets = [];
for (let i = 0; i < objCount; i++) offsets.push(parseInt(xrefLines[2 + i].slice(0, 10), 10));

let offsetOk = 0;
for (let i = 1; i < objCount; i++) {
  const o = offsets[i];
  const expect = `${i} 0 obj`;
  if (raw.slice(o, o + expect.length) === expect) offsetOk++;
  else problems.push(`对象 ${i} 的 xref 偏移 ${o} 未指向 "${expect}"`);
}
ok(offsetOk === objCount - 1, `全部 ${objCount - 1} 个对象的 xref 偏移正确`);

// ---------------------------------------------------------------- 3. 逐对象解析
// 关键：不再用正则扫描 "stream"（二进制流内可能包含该字节序列），
// 而是从 xref 给出的对象起点顺序解析，用 /Length 精确切分。
const objTypes = { Page: 0, Pages: 0, Font: 0, XObject: 0, Catalog: 0, FontDescriptor: 0 };
const fontsDeclared = new Set();
const imagesDeclared = new Set();
let pageObjs = 0;
let kidCount = 0;
let pagesCountValue = null;
const contentStreams = [];
let flateOk = 0, flateFail = 0, dctOk = 0, ttfChecked = 0;

for (let i = 1; i < objCount; i++) {
  const start = offsets[i];
  const end = i + 1 < objCount ? offsets[i + 1] : raw.length;
  const objText = raw.slice(start, end);

  const typeMatch = objText.match(/\/Type\s*\/(\w+)/);
  const type = typeMatch ? typeMatch[1] : null;
  if (type && objTypes[type] !== undefined) objTypes[type]++;

  if (type === 'Page') pageObjs++;
  if (type === 'Pages') {
    const c = objText.match(/\/Count\s+(\d+)/);
    pagesCountValue = c ? parseInt(c[1], 10) : null;
    const kids = objText.match(/\/Kids\s*\[([^\]]*)\]/);
    kidCount = kids ? kids[1].trim().split(/\s+0\s+R/).filter((s) => s.trim()).length : 0;
  }

  // 资源声明：/F_xxx N 0 R 与 /ImNN N 0 R
  for (const m of objText.matchAll(/\/(F_\w+)\s+\d+\s+0\s+R/g)) fontsDeclared.add(m[1]);
  for (const m of objText.matchAll(/\/(Im\d+)\s+\d+\s+0\s+R/g)) imagesDeclared.add(m[1]);

  // 流对象
  const sIdx = objText.indexOf('stream');
  if (sIdx < 0) continue;
  const dictText = objText.slice(0, sIdx);
  let dataStart = sIdx + 'stream'.length;
  if (objText[dataStart] === '\r') dataStart++;
  if (objText[dataStart] === '\n') dataStart++;
  const lenMatch = dictText.match(/\/Length\s+(\d+)/);
  if (!lenMatch) { problems.push(`对象 ${i} 有流但无 /Length`); continue; }
  const len = parseInt(lenMatch[1], 10);
  const absoluteStart = start + dataStart;
  const after = raw.slice(absoluteStart + len, absoluteStart + len + 20);
  if (!/^\s*endstream/.test(after)) {
    problems.push(`对象 ${i} 的 /Length=${len} 与流实际末端不符（其后为 ${JSON.stringify(after.slice(0, 12))}）`);
    continue;
  }
  const data = Buffer.from(raw.slice(absoluteStart, absoluteStart + len), 'latin1');

  if (/\/FlateDecode/.test(dictText)) {
    try {
      const dec = zlib.inflateSync(data);
      flateOk++;
      if (/\/Length1\s+\d+/.test(dictText)) {
        if (verifyTtf(dec, problems, i)) {
          ttfChecked++;
          if (dumpDir) {
            const base = (dictText.match(/\/BaseFont\s*\/([^\s/]+)/) || [, `obj${i}`])[1].replace(/[^\w+-]/g, '');
            fs.writeFileSync(path.join(dumpDir, `${base}.ttf`), dec);
          }
        }
      } else if (/\/Type\s*\/XObject/.test(dictText)) {
        problems.push(`对象 ${i} 是图像流却使用 FlateDecode`);
      } else if (/\/CMapType|\/CIDInit/.test(dec.toString('latin1'))) {
        // ToUnicode CMap
      } else {
        contentStreams.push(dec.toString('latin1'));
      }
    } catch (e) {
      flateFail++;
      problems.push(`对象 ${i} FlateDecode 解压失败: ${e.message}`);
    }
  } else if (/\/DCTDecode/.test(dictText)) {
    // JPEG 允许在 EOI 之后带填充字节，因此向前回溯查找 EOI，而不是要求正好落在末尾
    const eoi = data.lastIndexOf(Buffer.from([0xff, 0xd9]));
    const soi = data[0] === 0xff && data[1] === 0xd8;
    if (soi && eoi >= data.length - 64) dctOk++;
    else problems.push(`对象 ${i} 的 JPEG 流不完整（SOI=${soi}, EOI 距末尾 ${data.length - 2 - eoi} 字节）`);
  }
}

notes.push(`对象统计: Page=${objTypes.Page} Pages=${objTypes.Pages} Font=${objTypes.Font} ` +
           `FontDescriptor=${objTypes.FontDescriptor} XObject=${objTypes.XObject}`);
ok(pagesCountValue === pageObjs, `/Pages /Count=${pagesCountValue} 与 Page 对象数 ${pageObjs} 一致`);
ok(kidCount === pageObjs, `/Pages /Kids 数量 ${kidCount} 与 Page 对象数一致`);
ok(ttfChecked === 4, `内嵌字体子集数量 ${ttfChecked}（应为 4：正文黑体/雅黑/雅黑粗/宋体）`);
ok(flateFail === 0, `FlateDecode 流全部解压成功（${flateOk} 个）`);
ok(dctOk === objTypes.XObject, `JPEG 图像流完整（SOI+EOI，${dctOk}/${objTypes.XObject}）`);

// ---------------------------------------------------------------- 4. 内容流引用完整性
const allContent = contentStreams.join('\n');
const refsUsed = new Set();
for (const m of allContent.matchAll(/\/(F_\w+|Im\d+)\s/g)) refsUsed.add(m[1]);
const missingFonts = [...refsUsed].filter((r) => r.startsWith('F_') && !fontsDeclared.has(r));
const missingImgs = [...refsUsed].filter((r) => r.startsWith('Im') && !imagesDeclared.has(r));
ok(missingFonts.length === 0, '内容流引用的字体资源均已声明' + (missingFonts.length ? '，缺: ' + missingFonts.join(',') : ''));
ok(missingImgs.length === 0, '内容流引用的图像资源均已声明' + (missingImgs.length ? '，缺: ' + missingImgs.join(',') : ''));

const tjCount = (allContent.match(/Tj/g) || []).length;
const doCount = (allContent.match(/\/Im\d+ Do/g) || []).length;
notes.push(`内容流: 文本绘制 ${tjCount} 次，图像绘制 ${doCount} 次，内容流 ${contentStreams.length} 个`);

// ---------------------------------------------------------------- 5. TrueType 子集校验
function verifyTtf(dec, problems, objNum) {
  if (dec.length < 12) { problems.push(`对象 ${objNum} 字体子集过短`); return false; }
  const version = dec.readUInt32BE(0);
  if (version !== 0x00010000 && version !== 0x74727565) {
    problems.push(`对象 ${objNum} 字体子集 sfntVersion 异常: 0x${version.toString(16)}`);
    return false;
  }
  const numTables = dec.readUInt16BE(4);
  const tagList = [];
  let allInside = true;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = dec.toString('ascii', rec, rec + 4).trim();
    const off = dec.readUInt32BE(rec + 8);
    const len = dec.readUInt32BE(rec + 12);
    tagList.push(tag);
    if (off + len > dec.length) { problems.push(`对象 ${objNum} 字体表 ${tag} 越界`); allInside = false; }
  }
  for (const need of ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'loca', 'glyf']) {
    if (!tagList.includes(need)) problems.push(`对象 ${objNum} 字体子集缺少表 ${need}`);
  }
  const cmapOff = findTable(dec, numTables, 'cmap');
  if (cmapOff) {
    const subTables = dec.readUInt16BE(cmapOff + 2);
    if (subTables < 1) problems.push(`对象 ${objNum} 字体子集 cmap 子表数为 0`);
    // 解析第一个子表，确认能查到映射
    const subOff = cmapOff + dec.readUInt32BE(cmapOff + 8);
    const fmt = dec.readUInt16BE(subOff);
    if (fmt !== 4 && fmt !== 6 && fmt !== 12) problems.push(`对象 ${objNum} cmap 首个子表格式 ${fmt} 异常`);
  }
  const maxpOff = findTable(dec, numTables, 'maxp');
  const locaOff = findTable(dec, numTables, 'loca');
  if (maxpOff && locaOff) {
    const numGlyphs = dec.readUInt16BE(maxpOff + 4);
    const locaLen = dec.readUInt32BE(findTableRecord(dec, numTables, 'loca') + 12);
    if (locaLen < (numGlyphs + 1) * 4) {
      problems.push(`对象 ${objNum} 字体子集 loca 长度不足: ${locaLen} < ${(numGlyphs + 1) * 4}`);
    }
    if (numGlyphs < 2) problems.push(`对象 ${objNum} 字体子集字形数异常: ${numGlyphs}`);
    notes.push(`  · 字体子集 ${dec.length} B，numGlyphs=${numGlyphs}，表: ${tagList.join(' ')}`);
  }
  return allInside;
}
function findTableRecord(dec, numTables, name) {
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (dec.toString('ascii', rec, rec + 4).trim() === name) return rec;
  }
  return 0;
}
function findTable(dec, numTables, name) {
  const rec = findTableRecord(dec, numTables, name);
  return rec ? dec.readUInt32BE(rec + 8) : 0;
}

// ---------------------------------------------------------------- 6. 摘要
console.log('================ PDF 校验 ================');
console.log('文件      : ' + file);
console.log('大小      : ' + (buf.length / 1048576).toFixed(2) + ' MB');
console.log('页数      : ' + objTypes.Page);
console.log('');
notes.forEach((n) => console.log(n));
if (problems.length) {
  console.log('');
  console.log('发现问题 ' + problems.length + ' 项:');
  problems.forEach((p) => console.log('  ✗ ' + p));
  process.exit(1);
}
console.log('');
console.log('结论: 结构校验全部通过。');
