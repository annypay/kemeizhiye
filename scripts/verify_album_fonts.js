/**
 * 图集 PDF 字体保真校验：
 *   把 PDF 内嵌的 TrueType 子集与 Windows 系统原字体逐字形比对：
 *     1. 子集必须包含内容中用到的每一个字符（cmap 能查到）；
 *     2. 每个字符的字形轮廓必须与系统原字体逐字节一致；
 *     3. 每个字形的 advance width 必须与原字体一致。
 *
 * 字体归属不靠猜测：读取子集自身的 name 表得到 family 名，再映射到系统字体文件。
 *
 * 用法: node scripts/verify_album_fonts.js <pdf> <照片目录>
 *      PDF_FONT_DUMP=<dir> 时额外导出子集 ttf 与逐字形 hex，便于人工核对。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const pdfPath = process.argv[2];
const photoDir = process.argv[3];
if (!pdfPath || !photoDir) {
  console.error('用法: node scripts/verify_album_fonts.js <pdf> <照片目录>');
  process.exit(2);
}
const dumpDir = process.env.PDF_FONT_DUMP || '';
if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });

const WINDIR = process.env.WINDIR || 'C:\\Windows';
// 字体 family 名在不同语言环境下可能是中文或英文，这里同时登记两种写法
const SYSTEM_FONTS = {
  '黑体|regular': path.join(WINDIR, 'Fonts', 'simhei.ttf'),
  'SimHei|regular': path.join(WINDIR, 'Fonts', 'simhei.ttf'),
  '微软雅黑|regular': path.join(WINDIR, 'Fonts', 'msyh.ttc'),
  'Microsoft YaHei|regular': path.join(WINDIR, 'Fonts', 'msyh.ttc'),
  '微软雅黑|bold': path.join(WINDIR, 'Fonts', 'msyhbd.ttc'),
  'Microsoft YaHei|bold': path.join(WINDIR, 'Fonts', 'msyhbd.ttc'),
  '宋体|regular': path.join(WINDIR, 'Fonts', 'simsun.ttc'),
  'SimSun|regular': path.join(WINDIR, 'Fonts', 'simsun.ttc'),
};

/** subfamily 归一化：Gras/Bold/粗体 -> bold，其余 -> regular */
function normWeight(subfamily) {
  const s = (subfamily || '').toLowerCase();
  return /bold|gras|黑|粗/.test(s) ? 'bold' : 'regular';
}

// ================================================================ TTF 读取
class FontReader {
  constructor(buffer) {
    this.buf = buffer;
    this.tables = {};
    // ttc 中的表偏移是相对整个文件起点（不是相对 face 起点），因此用 base 而不是 subarray
    this.base = buffer.toString('ascii', 0, 4) === 'ttcf' ? buffer.readUInt32BE(12) : 0;
    const b = this.buf;
    const numTables = b.readUInt16BE(this.base + 4);
    this.numTables = numTables;
    for (let i = 0; i < numTables; i++) {
      const rec = this.base + 12 + i * 16;
      const tag = b.toString('ascii', rec, rec + 4).trim();
      this.tables[tag] = { offset: b.readUInt32BE(rec + 8), length: b.readUInt32BE(rec + 12) };
    }
    const head = this.tables.head.offset;
    this.indexToLocFormat = b.readInt16BE(head + 50);
    this.unitsPerEm = b.readUInt16BE(head + 18);
    this.numGlyphs = b.readUInt16BE(this.tables.maxp.offset + 4);
    this.numberOfHMetrics = b.readUInt16BE(this.tables.hhea.offset + 34);
    this.readLoca();
    this.readCmap();
    this.readNames();
  }

  /** name 表：取 family(1) 与 subfamily(2)，优先 Windows 平台记录 */
  readNames() {
    const n = this.tables.name;
    this.family = '';
    this.subfamily = '';
    if (!n) return;
    const b = this.buf;
    const count = b.readUInt16BE(n.offset + 2);
    const strOff = n.offset + b.readUInt16BE(n.offset + 4);
    const pick = { 1: '', 2: '' };
    for (let i = 0; i < count; i++) {
      const rec = n.offset + 6 + i * 12;
      const platformId = b.readUInt16BE(rec);
      const nameId = b.readUInt16BE(rec + 6);
      const len = b.readUInt16BE(rec + 8);
      const off = b.readUInt16BE(rec + 10);
      if (nameId !== 1 && nameId !== 2) continue;
      const bytes = b.subarray(strOff + off, strOff + off + len);
      const value = platformId === 3 || platformId === 0
        ? Buffer.from(bytes).swap16().toString('utf16le')
        : bytes.toString('latin1');
      if (!pick[nameId] || platformId === 3) pick[nameId] = value;
    }
    this.family = pick[1];
    this.subfamily = pick[2];
  }

  readLoca() {
    const l = this.tables.loca.offset;
    const n = this.numGlyphs + 1;
    this.loca = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      this.loca[i] = this.indexToLocFormat === 0
        ? this.buf.readUInt16BE(l + i * 2) * 2
        : this.buf.readUInt32BE(l + i * 4);
    }
  }

  readCmap() {
    const cm = this.tables.cmap.offset;
    const numTables = this.buf.readUInt16BE(cm + 2);
    const cands = [];
    for (let i = 0; i < numTables; i++) {
      const rec = cm + 4 + i * 8;
      const platformId = this.buf.readUInt16BE(rec);
      const encodingId = this.buf.readUInt16BE(rec + 2);
      const off = cm + this.buf.readUInt32BE(rec + 4);
      const format = this.buf.readUInt16BE(off);
      let score = 0;
      if (format === 4 && platformId === 3 && encodingId === 1) score = 5;
      else if (format === 12 && platformId === 3 && encodingId === 10) score = 4;
      else if (format === 4 && platformId === 0) score = 3;
      else if (format === 12) score = 2;
      else if (format === 4) score = 1;
      if (score) cands.push({ score, format, off });
    }
    cands.sort((a, b) => b.score - a.score);
    this.map = new Map();
    for (const c of cands) {
      if (c.format === 4) this.parseCmap4(c.off);
      else this.parseCmap12(c.off);
      if (this.map.size) break;
    }
  }

  parseCmap4(off) {
    const b = this.buf;
    const segCountX2 = b.readUInt16BE(off + 6);
    const segCount = segCountX2 / 2;
    const endBase = off + 14;
    const startBase = endBase + segCountX2 + 2;
    const deltaBase = startBase + segCountX2;
    const rangeBase = deltaBase + segCountX2;
    for (let s = 0; s < segCount; s++) {
      const end = b.readUInt16BE(endBase + s * 2);
      const start = b.readUInt16BE(startBase + s * 2);
      const delta = b.readInt16BE(deltaBase + s * 2);
      const rangeOffset = b.readUInt16BE(rangeBase + s * 2);
      if (start === 0xffff) continue;
      if (end - start > 0x10000) continue;
      for (let c = start; c <= end; c++) {
        let gid;
        if (rangeOffset === 0) {
          gid = (c + delta) & 0xffff;
        } else {
          const idx = rangeBase + s * 2 + rangeOffset + (c - start) * 2;
          if (idx + 1 >= b.length) continue;
          gid = b.readUInt16BE(idx);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid !== 0 && !this.map.has(c)) this.map.set(c, gid);
      }
    }
  }

  parseCmap12(off) {
    const b = this.buf;
    const nGroups = b.readUInt32BE(off + 12);
    for (let g = 0; g < nGroups; g++) {
      const rec = off + 16 + g * 12;
      const start = b.readUInt32BE(rec);
      const end = b.readUInt32BE(rec + 4);
      const startGid = b.readUInt32BE(rec + 8);
      if (end - start > 0x10000) continue;
      for (let c = start; c <= end; c++) if (!this.map.has(c)) this.map.set(c, startGid + (c - start));
    }
  }

  gid(cp) { return this.map.get(cp) || 0; }

  glyph(gid) {
    const b = this.buf;
    const glyfOff = this.tables.glyf.offset;
    const s = this.loca[gid];
    const e = this.loca[gid + 1];
    return e <= s ? Buffer.alloc(0) : b.subarray(glyfOff + s, glyfOff + e);
  }

  advance(gid) {
    const hmtx = this.tables.hmtx.offset;
    const idx = Math.min(gid, this.numberOfHMetrics - 1);
    return this.buf.readUInt16BE(hmtx + idx * 4);
  }
}

// ================================================================ 提取内嵌子集
const pdf = fs.readFileSync(pdfPath);
const raw = pdf.toString('latin1');
const xrefPos = parseInt(raw.slice(raw.lastIndexOf('startxref') + 9).trim().split(/\s/)[0], 10);
const xrefLines = raw.slice(xrefPos).split('\n');
const objCount = parseInt(xrefLines[1].trim().split(/\s+/)[1], 10);
const offsets = [];
for (let i = 0; i < objCount; i++) offsets.push(parseInt(xrefLines[2 + i].slice(0, 10), 10));

const embedded = [];
const toUnicodeByFontObj = new Map();   // FontFile2 对象号 -> Unicode 码点集合
for (let i = 1; i < objCount; i++) {
  const objText = raw.slice(offsets[i], i + 1 < objCount ? offsets[i + 1] : raw.length);
  const sIdx = objText.indexOf('stream');
  if (sIdx < 0) continue;
  const dict = objText.slice(0, sIdx);
  let ds = sIdx + 6;
  if (objText[ds] === '\r') ds++;
  if (objText[ds] === '\n') ds++;
  const len = parseInt(dict.match(/\/Length\s+(\d+)/)[1], 10);
  const data = Buffer.from(raw.slice(offsets[i] + ds, offsets[i] + ds + len), 'latin1');

  if (/\/Length1\s+\d+/.test(dict)) {
    const fontBuf = zlib.inflateSync(data);
    const fr = new FontReader(fontBuf);
    embedded.push({
      objNum: i,
      bytes: fontBuf.length,
      family: fr.family,
      subfamily: fr.subfamily,
      baseFont: (dict.match(/\/BaseFont\s*\/([^\s/]+)/) || [, ''])[1],
      font: fr,
    });
    if (dumpDir) {
      const safe = (fr.family + '-' + (fr.subfamily || 'Regular')).replace(/[^\w+-]/g, '_');
      fs.writeFileSync(path.join(dumpDir, `obj${i}-${safe}.ttf`), fontBuf);
    }
  } else if (/\/FlateDecode/.test(dict)) {
    // ToUnicode CMap：从 PDF 自身取出「本字体实际渲染了哪些字符」，不靠外部猜测。
    // 注意标记在解压后的数据里，不在字典里。
    const text = zlib.inflateSync(data).toString('latin1');
    if (!/begincmap/.test(text)) continue;
    const cps = new Set();
    for (const m of text.matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4,})>/g)) {
      const uni = m[2];
      for (let k = 0; k + 4 <= uni.length; k += 4) cps.add(parseInt(uni.slice(k, k + 4), 16));
    }
    toUnicodeByFontObj.set(i, cps);
  }
}

// 把 ToUnicode 按 Type0 字体 → FontFile2 建立对应关系：
// Type0(/DescendantFonts) -> CIDFont(/FontDescriptor) -> FontDescriptor(/FontFile2) -> 字体流对象号
const fidToTounicode = new Map();   // FontFile2 对象号 -> 码点集合
const objByNum = new Map();
for (let i = 1; i < objCount; i++) {
  objByNum.set(i, raw.slice(offsets[i], i + 1 < objCount ? offsets[i + 1] : raw.length));
}
for (const [num, text] of objByNum) {
  // 只处理 Type0 字体对象（不锚定字段顺序）
  if (!/\/Type\s*\/Font/.test(text) || !/\/Subtype\s*\/Type0/.test(text)) continue;
  const toUniM = text.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
  if (!toUniM) continue;
  const cps = toUnicodeByFontObj.get(parseInt(toUniM[1], 10));
  if (!cps) continue;
  // 顺着 DescendantFonts -> FontDescriptor -> FontFile2 找到字体流
  const descM = text.match(/\/DescendantFonts\s*\[\s*(\d+)\s+0\s+R/);
  if (!descM) continue;
  const cidText = objByNum.get(parseInt(descM[1], 10)) || '';
  const fdM = cidText.match(/\/FontDescriptor\s+(\d+)\s+0\s+R/);
  if (!fdM) continue;
  const fdText = objByNum.get(parseInt(fdM[1], 10)) || '';
  const ffM = fdText.match(/\/FontFile2\s+(\d+)\s+0\s+R/);
  if (!ffM) continue;
  fidToTounicode.set(parseInt(ffM[1], 10), cps);
}

// ================================================================ 内容用字
// 真值来自 PDF 自身的 ToUnicode CMap：它记录了每个内嵌字体实际渲染过的字符，
// 因此这里不需要（也不应该）靠外部文案去猜字符集。
const files = fs.readdirSync(photoDir).filter((n) => /\.(jpe?g|png)$/i.test(n));
if (!files.length) { console.error('照片目录为空：' + photoDir); process.exit(2); }

/** subfamily 归一化：Gras/Bold/粗体 -> bold，其余 -> regular */

// ================================================================ 比对
const problems = [];
const stats = [];
const dumpLines = [];

/** 比较字形轮廓：忽略尾部 4 字节对齐填充的差异 */
function sameOutline(a, b) {
  const trim = (x) => { let n = x.length; while (n > 0 && x[n - 1] === 0) n--; return n; };
  const na = trim(a);
  const nb = trim(b);
  if (na !== nb) return false;
  return a.subarray(0, na).equals(b.subarray(0, nb));
}

for (const emb of embedded) {
  const key = `${emb.family}|${normWeight(emb.subfamily)}`;
  const cps = fidToTounicode.get(emb.objNum);
  if (!cps || !cps.size) {
    problems.push(`内嵌子集 obj${emb.objNum} 未关联到 ToUnicode 码点集合`);
    continue;
  }
  const sysPath = SYSTEM_FONTS[key];
  if (!sysPath || !fs.existsSync(sysPath)) {
    problems.push(`找不到系统原字体文件：${key} -> ${sysPath}`);
    continue;
  }
  const sys = new FontReader(fs.readFileSync(sysPath));

  let checked = 0, missing = 0, outlineDiff = 0, widthDiff = 0, sysMissing = 0;
  for (const cp of [...cps].sort((a, b) => a - b)) {
    if (cp <= 0x1f) continue;
    if (cp === 0xffff || cp === 0xfffe) continue;   // cmap 结束哨兵码点，非真实字符
    const ch = String.fromCodePoint(cp);
    const gidSub = emb.font.gid(cp);
    if (gidSub === 0) {
      missing++;
      problems.push(`${key}: 子集缺少字符「${ch}」(U+${cp.toString(16).toUpperCase()})`);
      continue;
    }
    const gidSys = sys.gid(cp);
    if (gidSys === 0) { sysMissing++; continue; }
    const ga = emb.font.glyph(gidSub);
    const gb = sys.glyph(gidSys);
    // 两个字体对最后一个字形的 4 字节对齐填充可能不同，比较时去掉尾部 0 填充
    if (!sameOutline(ga, gb)) {
      outlineDiff++;
      problems.push(`${key}: 字符「${ch}」字形轮廓与系统字体不一致（子集 ${ga.length}B / 系统 ${gb.length}B）`);
    }
    const wa = emb.font.advance(gidSub);
    const wb = sys.advance(gidSys);
    if (wa !== wb) {
      widthDiff++;
      problems.push(`${key}: 字符「${ch}」advance 不一致（子集 ${wa} / 系统 ${wb}）`);
    }
    if (dumpDir) {
      dumpLines.push(`${key}\t${ch}\tU+${cp.toString(16).toUpperCase()}\tgid=${gidSub}/${gidSys}\tadv=${wa}/${wb}\tglyf=${ga.toString('hex')}`);
    }
    checked++;
  }
  stats.push({ key, bytes: emb.bytes, numGlyphs: emb.font.numGlyphs, checked, missing, outlineDiff, widthDiff, sysMissing });
  void files;
}

if (dumpDir && dumpLines.length) {
  fs.writeFileSync(path.join(dumpDir, 'glyph-compare.tsv'), dumpLines.join('\n'), 'utf8');
}

// ================================================================ 输出
console.log('============ 图集 PDF 字体保真校验 ============');
console.log('PDF       : ' + pdfPath);
console.log('照片目录  : ' + photoDir);
console.log('内嵌子集  : ' + embedded.length + ' 个 -> ' + embedded.map((e) => `${e.family}/${e.subfamily || 'Regular'}`).join(', '));
console.log('');
for (const s of stats) {
  console.log(`  ${s.key.padEnd(26)} 子集 ${String(s.bytes).padStart(7)} B / ${String(s.numGlyphs).padStart(4)} 字形  ` +
              `比对 ${String(s.checked).padStart(3)}  缺字 ${s.missing}  轮廓不符 ${s.outlineDiff}  宽度不符 ${s.widthDiff}  系统缺字 ${s.sysMissing}`);
}
console.log('');
if (problems.length) {
  console.log('发现问题 ' + problems.length + ' 项:');
  problems.slice(0, 30).forEach((p) => console.log('  ✗ ' + p));
  if (problems.length > 30) console.log(`  ... 其余 ${problems.length - 30} 项省略`);
  process.exit(1);
}
console.log('结论: PDF 内嵌字体子集的 cmap 覆盖、字形轮廓与 advance 宽度均与系统原字体逐字节一致。');
