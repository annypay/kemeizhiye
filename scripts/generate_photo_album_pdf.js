/**
 * 现场图集 PDF 生成器（零依赖，纯 Node 手写 PDF）。
 *
 * 用途：把某个现场照片文件夹按文件名顺序排版成一本 A4 PDF 图集：
 *   · 封面：项目名称、图集名称、拍摄日期、照片数量、图片来源目录、编制部门与日期；
 *   · 正文：每页 1 张照片，照片下方图注为「图 N　<原文件名>」（= 该照片的文件名）；
 *   · 附录：照片索引表（序号 / 部位内容 / 文件名）；
 *   · 页眉：图集名称；页脚：编制单位 + 第 X 页 / 共 Y 页。
 *
 * 设计要点：
 *   1. 零第三方依赖：JPEG 以 DCTDecode 原样嵌入（不重新编码，画质无损、速度快）；
 *   2. 文字使用真实 CJK 字体子集（微软雅黑 / 黑体 / 宋体），图注可选中、可全文检索；
 *   3. 只读取源目录，绝不改名、不改写、不移动原始照片。
 *
 * 用法：
 *   node scripts/generate_photo_album_pdf.js \
 *     --src "C:\Users\mrseven\Pictures\20260915现场图片" \
 *     --out "00-临时存放/20260915-总经办-现场图集.pdf" \
 *     --title "20260915 现场图集" --date 20260915
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CM = 28.3464567;
const A4 = { w: 21.0 * CM, h: 29.7 * CM };
const MARGIN = 2.0 * CM;

// ---------------------------------------------------------------- 命令行参数
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SRC = args.src;
const OUT = args.out;
const TITLE = args.title || '现场图集';
const SHOOT_DATE = args.date || '';
const PROJECT = args.project || '江西柯美纸业年产30万吨包装用纸及特种纸生产线项目二期';
const DEPT = args.dept || '江西柯美纸业 · 总经办';
const PHOTO_W = parseFloat(args.photow || '15.0') * CM;
const PHOTO_MAX_H = parseFloat(args.photoh || '11.0') * CM;

if (!SRC || !OUT) {
  console.error('用法: node scripts/generate_photo_album_pdf.js --src <照片目录> --out <输出.pdf> [--title 图集名称] [--date YYYYMMDD]');
  process.exit(2);
}

const FONT_DIR = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
const FONT_FILES = {
  // 展示名 -> 字体文件（微软雅黑为 ttc，取第 0 个 face）
  yahei: path.join(FONT_DIR, 'msyh.ttc'),
  yaheiBold: path.join(FONT_DIR, 'msyhbd.ttc'),
  heiti: path.join(FONT_DIR, 'simhei.ttf'),
  songti: path.join(FONT_DIR, 'simsun.ttc'),
};
const FACE_INDEX = { yahei: 0, yaheiBold: 0, heiti: 0, songti: 0 };

// ================================================================ 1. TTF 解析与子集化
class TtfFont {
  constructor(buffer, faceIndex) {
    this.buf = buffer;
    this.tables = {};
    this.readTableDirectory(faceIndex);
    this.readHead();
    this.readMaxp();
    this.readHhea();
    this.readCmap();
    this.readLoca();
    this.readHmtx();
    this.readOs2();
  }

  u8(o) { return this.buf.readUInt8(o); }
  u16(o) { return this.buf.readUInt16BE(o); }
  i16(o) { return this.buf.readInt16BE(o); }
  u32(o) { return this.buf.readUInt32BE(o); }

  readTableDirectory(faceIndex) {
    const b = this.buf;
    let tag = b.toString('ascii', 0, 4);
    let base = 0;
    if (tag === 'ttcf') {
      const numFonts = this.u32(8);
      if (faceIndex >= numFonts) throw new Error(`ttc 第 ${faceIndex} 个 face 不存在（共 ${numFonts} 个）`);
      base = this.u32(12 + faceIndex * 4);
    }
    const numTables = this.u16(base + 4);
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      const name = b.toString('ascii', rec, rec + 4);
      this.tables[name] = { offset: this.u32(rec + 8), length: this.u32(rec + 12) };
    }
    if (!this.tables.glyf || !this.tables.loca || !this.tables.cmap || !this.tables.head) {
      throw new Error('字体缺少必要表（glyf/loca/cmap/head）');
    }
  }

  table(name) {
    const t = this.tables[name];
    if (!t) return null;
    return this.buf.subarray(t.offset, t.offset + t.length);
  }

  readHead() {
    const h = this.tables.head.offset;
    this.unitsPerEm = this.u16(h + 18);
    this.indexToLocFormat = this.i16(h + 50);
    this.headTable = this.table('head');
  }

  readMaxp() {
    const m = this.tables.maxp.offset;
    this.numGlyphs = this.u16(m + 4);
  }

  readHhea() {
    const h = this.tables.hhea.offset;
    this.ascent = this.i16(h + 4);
    this.descent = this.i16(h + 6);
    this.lineGap = this.i16(h + 8);
    this.numberOfHMetrics = this.u16(h + 34);
    this.hheaTable = this.table('hhea');
  }

  readOs2() {
    this.os2Table = this.table('OS/2');
    if (this.os2Table) {
      // fsType 偏移 8：bit1=Restricted License embedding，bit9=NoSubsetting
      this.fsType = this.os2Table.readUInt16BE(8);
    } else {
      this.fsType = 0;
    }
    this.embeddingAllowed = (this.fsType & 0x0002) === 0 && (this.fsType & 0x0200) === 0;
  }

  readCmap() {
    const cm = this.tables.cmap.offset;
    const numTables = this.u16(cm + 2);
    let best = null;
    for (let i = 0; i < numTables; i++) {
      const rec = cm + 4 + i * 8;
      const platformId = this.u16(rec);
      const encodingId = this.u16(rec + 2);
      const offset = cm + this.u32(rec + 4);
      const format = this.u16(offset);
      let score = -1;
      if (format === 12 && platformId === 3 && encodingId === 10) score = 5;
      else if (format === 4 && platformId === 3 && encodingId === 1) score = 4;
      else if (format === 12) score = 3;
      else if (format === 4) score = 2;
      else if (format === 6) score = 1;
      if (score > 0 && (!best || score > best.score)) best = { score, format, offset };
    }
    if (!best) throw new Error('字体没有可用的 cmap 子表');
    this.map = best.format === 12 ? this.parseCmap12(best.offset) : this.parseCmap4(best.offset);
  }

  parseCmap4(off) {
    const map = new Map();
    const segCountX2 = this.u16(off + 6);
    const segCount = segCountX2 / 2;
    const endBase = off + 14;
    const startBase = endBase + segCountX2 + 2;
    const deltaBase = startBase + segCountX2;
    const rangeBase = deltaBase + segCountX2;
    for (let s = 0; s < segCount; s++) {
      const end = this.u16(endBase + s * 2);
      const start = this.u16(startBase + s * 2);
      const delta = this.i16(deltaBase + s * 2);
      const rangeOffset = this.u16(rangeBase + s * 2);
      if (start === 0xffff) continue;
      for (let c = start; c <= end; c++) {
        let gid;
        if (rangeOffset === 0) {
          gid = (c + delta) & 0xffff;
        } else {
          const idx = rangeBase + s * 2 + rangeOffset + (c - start) * 2;
          if (idx + 1 >= this.buf.length) continue;
          gid = this.u16(idx);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid !== 0) map.set(c, gid);
      }
    }
    return map;
  }

  parseCmap12(off) {
    const map = new Map();
    const nGroups = this.u32(off + 12);
    for (let g = 0; g < nGroups; g++) {
      const rec = off + 16 + g * 12;
      const start = this.u32(rec);
      const end = this.u32(rec + 4);
      const startGid = this.u32(rec + 8);
      if (end - start > 0x20000) continue; // 防御异常表
      for (let c = start; c <= end; c++) map.set(c, startGid + (c - start));
    }
    return map;
  }

  readLoca() {
    const l = this.tables.loca.offset;
    const n = this.numGlyphs + 1;
    this.loca = new Uint32Array(n);
    if (this.indexToLocFormat === 0) {
      for (let i = 0; i < n; i++) this.loca[i] = this.u16(l + i * 2) * 2;
    } else {
      for (let i = 0; i < n; i++) this.loca[i] = this.u32(l + i * 4);
    }
  }

  readHmtx() {
    const h = this.tables.hmtx.offset;
    this.advance = new Uint16Array(this.numGlyphs);
    for (let i = 0; i < this.numGlyphs; i++) {
      const idx = Math.min(i, this.numberOfHMetrics - 1);
      this.advance[i] = this.u16(h + idx * 4);
    }
  }

  gidFor(codePoint) {
    return this.map.get(codePoint) || 0;
  }

  /** 字形原始数据（不含 4 字节对齐填充） */
  glyphData(gid) {
    const glyfOff = this.tables.glyf.offset;
    const start = this.loca[gid];
    const end = this.loca[gid + 1];
    if (end <= start) return Buffer.alloc(0);
    return this.buf.subarray(glyfOff + start, glyfOff + end);
  }

  /** 生成只含指定字符的子集字体，返回 { buffer, gidToCid, cidToGid, cidToWidth } */
  subset(charSet) {
    const chars = Array.from(charSet).filter((ch) => ch.codePointAt(0) > 0x1f);
    // 按码点顺序分配 CID：这样 cmap 里连续的码点对应连续的 CID，
    // 能合并成尽可能少的段，避免格式 4 的稀疏表被撑爆。
    chars.sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
    const gids = [];
    const cidToGid = [0];
    const gidToCid = new Map();
    const missing = [];
    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      const gid = this.gidFor(cp);
      if (gid === 0) { missing.push(ch); continue; }
      if (gidToCid.has(gid)) continue;
      const cid = cidToGid.length;
      gidToCid.set(gid, cid);
      cidToGid.push(gid);
      gids.push(gid);
    }
    if (missing.length) {
      throw new Error(`字体缺少字形：${missing.map((c) => `${c}(U+${c.codePointAt(0).toString(16).toUpperCase()})`).join(' ')}`);
    }

    const n = gids.length + 1; // +.notdef
    const glyfParts = [];
    const loca = new Uint32Array(n + 1);
    let offset = 0;
    for (let i = 0; i < n; i++) {
      loca[i] = offset;
      const gid = i === 0 ? 0 : gids[i - 1];
      const data = this.glyphData(gid);
      if (data.length) {
        glyfParts.push(data);
        offset += data.length;
      }
      const pad = (4 - (offset % 4)) % 4;
      if (pad) { glyfParts.push(Buffer.alloc(pad)); offset += pad; }
    }
    loca[n] = offset;
    const glyfBuf = Buffer.concat(glyfParts, offset);

    const locaBuf = Buffer.alloc((n + 1) * 4);
    for (let i = 0; i <= n; i++) locaBuf.writeUInt32BE(loca[i], i * 4);

    const head = Buffer.from(this.headTable);
    head.writeInt32BE(0, 8);            // checkSumAdjustment 先清零，最后统一计算
    head.writeInt32BE(0, 50);           // indexToLocFormat = 0（长格式，无需改）
    head.writeInt16BE(1, 50);           // 明确写为 1 = long offsets

    const maxp = Buffer.from(this.table('maxp'));
    maxp.writeUInt16BE(n, 4);           // numGlyphs

    // hmtx：子集字形按新顺序重排
    const hmtx = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const gid = i === 0 ? 0 : gids[i - 1];
      hmtx.writeUInt16BE(this.advance[gid] || 0, i * 4);
      hmtx.writeInt16BE(0, i * 4 + 2);
    }
    const hhea = Buffer.from(this.hheaTable);
    hhea.writeUInt16BE(n, 34);          // numberOfHMetrics

    // cmap：Unicode -> 子集 gid（格式 4 + 格式 6 各一份，只覆盖用到的字符）
    const cmap = this.buildCmap(cidToGid);

    // post：版本 3.0（无 glyph name）
    const post = Buffer.alloc(32);
    post.writeUInt32BE(0x00030000, 0);
    post.writeInt32BE(0, 4);
    post.writeInt16BE(0, 8);
    post.writeInt16BE(0, 10);
    post.writeUInt32BE(0, 12);
    post.writeUInt32BE(0, 16);
    post.writeUInt32BE(0, 20);
    post.writeUInt32BE(0, 24);
    post.writeUInt32BE(0, 28);

    const tables = {
      head,
      hhea,
      maxp,
      hmtx,
      cmap,
      loca: locaBuf,
      glyf: glyfBuf,
      post,
    };
    if (this.os2Table) tables['OS/2'] = Buffer.from(this.os2Table);
    const name = this.table('name');
    if (name) tables.name = Buffer.from(name);

    const subsets = {};
    for (const [tag, data] of Object.entries(tables)) {
      subsets[tag] = this.subsetTable(tag, data, cidToGid, charSet);
    }

    const fontBuf = this.assemble(subsets);
    const cidToWidth = new Uint16Array(cidToGid.length);
    for (let cid = 0; cid < cidToGid.length; cid++) {
      cidToWidth[cid] = this.advance[cidToGid[cid]] || 0;
    }
    return { buffer: fontBuf, gidToCid, cidToGid, cidToWidth };
  }

  subsetTable(tag, data, cidToGid, charSet) {
    if (tag !== 'cmap') return data;
    return data;
  }

  /** 构造 Unicode cmap：格式 4（BMP）+ 格式 6（兼容） */
  buildCmap(cidToGid) {
    // 反查 gid -> cid，再按码点排序
    const gidToCid = new Map();
    for (let cid = 1; cid < cidToGid.length; cid++) gidToCid.set(cidToGid[cid], cid);
    const pairs = [];
    for (const [cp, gid] of this.map.entries()) {
      if (cp > 0xffff) continue;
      if (isPrivateUse(cp)) continue;      // 私用区码点常与常用字形互为别名，会撑爆格式 4
      const cid = gidToCid.get(gid);
      if (cid) pairs.push([cp, cid]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    if (!pairs.length) pairs.push([0x20, 0]);

    // 字体内部可能把常用字形同时挂在正常码点与高位别名码点（如 U+FF00、私用区）上。
    // 私用区已在上面剔除；这里再按「全部 BMP 常用码点」限定上限，
    // 避免个别别名码点把格式 4 的稀疏表撑爆。
    const maxMappedCp = pairs[pairs.length - 1][0];
    const maxCpLimit = 0xffff;
    const limitedPairs = pairs.filter(([cp]) => cp <= maxCpLimit && cp <= maxMappedCp);
    if (!limitedPairs.length) limitedPairs.push([0x20, 0]);
    pairs.length = 0;
    pairs.push(...limitedPairs);

    // ---- 格式 4：按连续段构建
    const segs = [];
    let cur = { start: pairs[0][0], end: pairs[0][0], cids: [pairs[0][1]] };
    for (let i = 1; i < pairs.length; i++) {
      const [cp, cid] = pairs[i];
      const prev = cur.cids[cur.cids.length - 1];
      if (cp === cur.end + 1 && cid === prev + 1) {
        cur.end = cp;
        cur.cids.push(cid);
      } else {
        segs.push(cur);
        cur = { start: cp, end: cp, cids: [cid] };
      }
    }
    segs.push(cur);
    segs.push({ start: 0xffff, end: 0xffff, cids: [0] }); // 必需的结束段

    const segCount = segs.length;
    const endCodes = Buffer.alloc(segCount * 2);
    const startCodes = Buffer.alloc(segCount * 2);
    const idDeltas = Buffer.alloc(segCount * 2);
    const idRangeOffsets = Buffer.alloc(segCount * 2);
    const glyphIdArray = [];

    segs.forEach((seg, s) => {
      endCodes.writeUInt16BE(seg.end, s * 2);
      startCodes.writeUInt16BE(seg.start, s * 2);
      if (s === segCount - 1) {
        idDeltas.writeInt16BE(1, s * 2);
        idRangeOffsets.writeUInt16BE(0, s * 2);
        return;
      }
      const contiguous = seg.cids.every((cid, k) => cid === seg.cids[0] + k) && seg.cids[0] !== 0;
      if (contiguous) {
        const delta = (seg.cids[0] - seg.start) & 0xffff;
        idDeltas.writeInt16BE(delta > 0x7fff ? delta - 0x10000 : delta, s * 2);
        idRangeOffsets.writeUInt16BE(0, s * 2);
      } else {
        idDeltas.writeInt16BE(0, s * 2);
        // glyphIdArray 是「自段起点起算」的稀疏数组：段起点之前的位置必须用 0 占位，
        // 这样 idRangeOffset 才能保持在 16 位范围内（段与段之间不允许重叠加减）。
        while (glyphIdArray.length < seg.start) glyphIdArray.push(0);
        while (glyphIdArray.length < seg.end + 1) glyphIdArray.push(0);   // 段内空档补 0
        for (let i = 0; i < seg.cids.length; i++) {
          glyphIdArray[seg.start + i] = seg.cids[i];
        }
        // idRangeOffset = 从本字段起，到 glyphIdArray 中「本段起点」条目的字节偏移
        const byteOff = 2 * ((segCount - s) + (glyphIdArray.length - seg.cids.length));
        if (byteOff > 0xffff) {
          throw new Error(`cmap 格式 4 的 idRangeOffset 溢出（${byteOff}），需缩小用字范围`);
        }
        idRangeOffsets.writeUInt16BE(byteOff, s * 2);
      }
    });

    const glyphArrBuf = Buffer.alloc(glyphIdArray.length * 2);
    glyphIdArray.forEach((g, i) => glyphArrBuf.writeUInt16BE(g, i * 2));

    const fmt4Len = 16 + segCount * 8 + glyphArrBuf.length;
    const fmt4 = Buffer.alloc(fmt4Len);
    let p = 0;
    fmt4.writeUInt16BE(4, p); p += 2;
    fmt4.writeUInt16BE(fmt4Len, p); p += 2;
    fmt4.writeUInt16BE(0, p); p += 2;              // language
    fmt4.writeUInt16BE(segCount * 2, p); p += 2;   // segCountX2
    const maxPow2 = Math.pow(2, Math.floor(Math.log2(segCount)));
    fmt4.writeUInt16BE(maxPow2 * 2, p); p += 2;    // searchRange
    fmt4.writeUInt16BE(Math.log2(maxPow2), p); p += 2; // entrySelector
    fmt4.writeUInt16BE(segCount * 2 - maxPow2 * 2, p); p += 2; // rangeShift
    endCodes.copy(fmt4, p); p += endCodes.length;
    fmt4.writeUInt16BE(0, p); p += 2;              // reservedPad
    startCodes.copy(fmt4, p); p += startCodes.length;
    idDeltas.copy(fmt4, p); p += idDeltas.length;
    idRangeOffsets.copy(fmt4, p); p += idRangeOffsets.length;
    glyphArrBuf.copy(fmt4, p);

    // ---- 格式 6（仅作兼容，条目跨度上限 0x2000，避免长度字段 16 位溢出）
    const bmpPairs = pairs.filter(([cp]) => cp >= 0 && cp <= 0xffff);
    const firstCode = bmpPairs.length ? bmpPairs[0][0] : 0;
    let lastCode = bmpPairs.length ? bmpPairs[bmpPairs.length - 1][0] : 0;
    if (lastCode - firstCode > 0x1fff) lastCode = firstCode + 0x1fff;
    const entryCount = lastCode - firstCode + 1;
    const fmt6 = Buffer.alloc(10 + entryCount * 2);
    fmt6.writeUInt16BE(6, 0);
    fmt6.writeUInt16BE(10 + entryCount * 2, 2);
    fmt6.writeUInt16BE(0, 4);
    fmt6.writeUInt16BE(firstCode, 6);
    fmt6.writeUInt16BE(entryCount, 8);
    const cidByCode = new Map(bmpPairs);
    for (let i = 0; i < entryCount; i++) {
      fmt6.writeUInt16BE(cidByCode.get(firstCode + i) || 0, 10 + i * 2);
    }

    // ---- cmap 总表
    const header = Buffer.alloc(4 + 2 * 8);
    header.writeUInt16BE(0, 0);
    header.writeUInt16BE(2, 2);
    header.writeUInt16BE(3, 4); header.writeUInt16BE(1, 6); header.writeUInt32BE(header.length, 8);
    header.writeUInt16BE(0, 12); header.writeUInt16BE(3, 14); header.writeUInt32BE(header.length + fmt4.length, 16);
    return Buffer.concat([header, fmt4, fmt6]);
  }

  /** 组装 TTF 文件：表目录 + 表数据 + 校验和 */
  assemble(tables) {
    const tags = Object.keys(tables).sort();
    const numTables = tags.length;
    const maxPow2 = Math.pow(2, Math.floor(Math.log2(numTables)));
    const headerSize = 12 + numTables * 16;

    let offset = headerSize;
    const records = [];
    for (const tag of tags) {
      const data = tables[tag];
      records.push({ tag, data, offset, length: data.length, checksum: checksum(data) });
      offset += data.length;
      const pad = (4 - (offset % 4)) % 4;
      offset += pad;
    }
    const total = offset;
    const out = Buffer.alloc(total);
    out.writeUInt32BE(0x00010000, 0);
    out.writeUInt16BE(numTables, 4);
    out.writeUInt16BE(maxPow2 * 16, 6);
    out.writeUInt16BE(Math.log2(maxPow2), 8);
    out.writeUInt16BE(numTables * 16 - maxPow2 * 16, 10);

    records.forEach((r, i) => {
      const rec = 12 + i * 16;
      const tagBuf = Buffer.alloc(4);                       // 表标签恒为 4 字节，短标签补 0（如 OS/2）
      tagBuf.write(r.tag, 0, Math.min(4, r.tag.length), 'ascii');
      tagBuf.copy(out, rec);
      out.writeUInt32BE(r.checksum, rec + 4);
      out.writeUInt32BE(r.offset, rec + 8);
      out.writeUInt32BE(r.length, rec + 12);
      r.data.copy(out, r.offset);
    });

    // head.checkSumAdjustment = 0xB1B0AFBA - 整字体校验和
    const headRec = records.find((r) => r.tag === 'head');
    if (headRec) {
      const fontChecksum = checksum(out);
      out.writeInt32BE((0xb1b0afba - fontChecksum) | 0, headRec.offset + 8);
    }
    return out;
  }
}

/** Unicode 私用区判断：这些码点在中文字体里常与常用字形互为别名，嵌入子集时须剔除 */
function isPrivateUse(cp) {
  return (cp >= 0xe000 && cp <= 0xf8ff) ||        // BMP PUA
         (cp >= 0xf0000 && cp <= 0xffffd) ||      // Supplementary PUA-A
         (cp >= 0x100000 && cp <= 0x10fffd);      // Supplementary PUA-B
}

function checksum(buf) {  let sum = 0;
  const n = buf.length;
  for (let i = 0; i < n; i += 4) {
    const b0 = buf[i] || 0;
    const b1 = i + 1 < n ? buf[i + 1] : 0;
    const b2 = i + 2 < n ? buf[i + 2] : 0;
    const b3 = i + 3 < n ? buf[i + 3] : 0;
    sum = (sum + ((b0 << 24) >>> 0) + (b1 << 16) + (b2 << 8) + b3) >>> 0;
  }
  return sum >>> 0;
}

// ================================================================ 2. 字体注册表
const fontCache = new Map();
function loadFont(key) {
  if (fontCache.has(key)) return fontCache.get(key);
  const file = FONT_FILES[key];
  if (!fs.existsSync(file)) throw new Error(`字体文件不存在：${file}`);
  const buf = fs.readFileSync(file);
  const font = new TtfFont(buf, FACE_INDEX[key] || 0);
  if (!font.embeddingAllowed) {
    console.warn(`[警告] ${path.basename(file)} 的 fsType=0x${font.fsType.toString(16)} 限制嵌入，请确认授权。`);
  }
  fontCache.set(key, font);
  return font;
}

// ================================================================ 3. PDF 写入器
class PdfWriter {
  constructor() {
    this.objects = [];   // { num, body: Buffer|string }
    this.next = 1;
    this.pages = [];
  }

  alloc() { return this.next++; }

  set(num, body) { this.objects[num] = body; return num; }

  addStream(dict, data) {
    const num = this.alloc();
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary');
    this.objects[num] = { dict: { ...dict, Length: buf.length }, data: buf };
    return num;
  }

  addObject(obj) {
    const num = this.alloc();
    this.objects[num] = obj;
    return num;
  }

  serialize() {
    const chunks = [];
    const offsets = [];
    let pos = 0;
    const push = (s) => {
      const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1');
      chunks.push(b);
      pos += b.length;
    };

    push('%PDF-1.7\n');
    push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // 二进制标记

    for (let i = 1; i < this.next; i++) {
      const obj = this.objects[i];
      if (obj === undefined) continue;
      offsets[i] = pos;
      push(`${i} 0 obj\n`);
      if (obj && obj.dict) {
        push(formatDict(obj.dict));
        push('\nstream\n');
        push(obj.data);
        push('\nendstream');
      } else if (typeof obj === 'string') {
        push(obj);
      } else if (Buffer.isBuffer(obj)) {
        push(obj);
      }
      push('\nendobj\n');
    }

    const xrefPos = pos;
    push(`xref\n0 ${this.next}\n`);
    push('0000000000 65535 f \n');
    for (let i = 1; i < this.next; i++) {
      const off = offsets[i] || 0;
      push(`${String(off).padStart(10, '0')} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${this.next} /Root ${this.rootRef} /Info ${this.infoRef} >>\nstartxref\n${xrefPos}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }
}

function pdfString(s) {
  // UTF-16BE + BOM，用于 PDF 文本字符串（标题等信息）
  const buf = Buffer.alloc(2 + s.length * 2);
  buf.writeUInt16BE(0xfeff, 0);
  for (let i = 0; i < s.length; i++) buf.writeUInt16BE(s.charCodeAt(i), 2 + i * 2);
  const hex = buf.toString('hex').toUpperCase();
  return `<${hex}>`;
}

function formatDict(dict) {
  const parts = [];
  for (const [k, v] of Object.entries(dict)) {
    if (v === undefined || v === null) continue;
    parts.push(`/${k} ${v}`);
  }
  return `<< ${parts.join(' ')} >>`;
}

// 字体映射：字体 key -> 子集信息（含 gidToCid），在子集化之后填充
const fontMaps = {};

/** 资源名 F_xxx -> 字体 key xxx */
function fontKeyOf(resourceName) {
  return resourceName.replace(/^F_/, '');
}

/**
 * 把字符串编码为 Identity-H 内容流里的十六进制串。
 * 关键：Identity-H 下 <...> Tj 的每 2 字节是 **CID**，不是 Unicode 码点。
 * 必须经 字符 -> 字体 gid -> 子集 CID 转换，否则渲染出来是错字。
 */
function encodeText(fontKey, str) {
  const sub = fontMaps[fontKey];
  if (!sub) throw new Error(`字体 ${fontKey} 尚未子集化，无法编码文本`);
  const font = loadFont(fontKey);
  const parts = [];
  for (const ch of str) {
    const gid = font.gidFor(ch.codePointAt(0));
    const cid = sub.gidToCid.get(gid);
    if (cid === undefined) {
      throw new Error(`字体 ${fontKey} 缺少字符「${ch}」(U+${ch.codePointAt(0).toString(16).toUpperCase()}) 的 CID 映射`);
    }
    parts.push(cid.toString(16).toUpperCase().padStart(4, '0'));
  }
  return parts.join('');
}

// ================================================================ 4. 内容流生成
class Content {
  constructor() { this.ops = []; }
  text(fontName, size, color, x, y, str) {
    const c = color.map((v) => (v / 255).toFixed(3)).join(' ');
    this.ops.push(`BT /${fontName} ${size.toFixed(2)} Tf ${c} rg ${x.toFixed(2)} ${y.toFixed(2)} Td <${encodeText(fontKeyOf(fontName), str)}> Tj ET`);
    return this;
  }
  rect(x, y, w, h, color) {
    const c = color.map((v) => (v / 255).toFixed(3)).join(' ');
    this.ops.push(`${c} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
    return this;
  }
  line(x1, y1, x2, y2, color, width) {
    const c = color.map((v) => (v / 255).toFixed(3)).join(' ');
    this.ops.push(`${c} RG ${width.toFixed(2)} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
    return this;
  }
  image(name, x, y, w, h) {
    this.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`);
    return this;
  }
  toString() { return this.ops.join('\n'); }
}

// ================================================================ 5. JPEG 解析
function readJpegInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 65536));
    fs.readSync(fd, head, 0, head.length, 0);
    if (head[0] !== 0xff || head[1] !== 0xd8) throw new Error(`不是 JPEG 文件：${file}`);
    let i = 2;
    while (i < head.length - 1) {
      if (head[i] !== 0xff) { i++; continue; }
      const marker = head[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = head.readUInt16BE(i + 5);
        const w = head.readUInt16BE(i + 7);
        const comps = head[i + 9];
        return { width: w, height: h, components: comps };
      }
      const len = head.readUInt16BE(i + 2);
      i += 2 + len;
    }
    throw new Error(`无法解析 JPEG 尺寸：${file}`);
  } finally {
    fs.closeSync(fd);
  }
}

// ================================================================ 6. 排版主流程
/** 照片页下方的来源小字（用字收集与渲染共用，保证一致） */
function smallTextOf(it) {
  return `文件名：${it.name}　|　${it.width}×${it.height} px　|　${(it.size / 1048576).toFixed(2)} MB`;
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error(`照片目录不存在：${SRC}`);
  const photos = fs.readdirSync(SRC, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.(jpe?g|png|bmp|tif|tiff)$/i.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

  if (!photos.length) throw new Error(`照片目录没有可用图片：${SRC}`);

  // ---- 载入照片元数据
  const items = photos.map((name, idx) => {
    const full = path.join(SRC, name);
    const info = readJpegInfo(full);
    const ratio = info.width / info.height;
    let dispW = PHOTO_W;
    let dispH = dispW / ratio;
    if (dispH > PHOTO_MAX_H) { dispH = PHOTO_MAX_H; dispW = dispH * ratio; }
    return {
      seq: idx + 1,
      name,
      caption: path.basename(name, path.extname(name)),
      full,
      size: fs.statSync(full).size,
      width: info.width,
      height: info.height,
      comps: info.components,
      dispW,
      dispH,
    };
  });

  // ---- 收集所有需要渲染的字符，按字体分组
  const chars = { yahei: new Set(), yaheiBold: new Set(), heiti: new Set(), songti: new Set() };
  const add = (key, s) => { for (const ch of s) chars[key].add(ch); };

  const shootText = SHOOT_DATE
    ? (/^\d{8}$/.test(SHOOT_DATE)
        ? `${SHOOT_DATE.slice(0, 4)}年${SHOOT_DATE.slice(4, 6)}月${SHOOT_DATE.slice(6, 8)}日`
        : SHOOT_DATE)
    : '（未标注）';
  const dateText = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  const infoRows = [
    ['拍摄日期', shootText],
    ['照片数量', `${items.length} 张`],
    ['图片来源', SRC],
    ['图注说明', '照片下方图注即该照片的文件名，文件名已按拍摄部位与内容命名'],
    ['编制部门', DEPT],
    ['编制日期', dateText],
  ];

  add('yaheiBold', TITLE);
  add('yahei', PROJECT);
  add('yahei', '现场施工情况照片汇编');
  infoRows.forEach(([k, v]) => { add('yahei', k + '：'); add('yahei', v); });
  add('songti', '本图集用于现场情况说明与内部沟通，照片内容以原始文件为准。');

  items.forEach((it) => {
    add('heiti', `${it.seq} 图`);          // 图注「图 N　名称」
    add('heiti', it.caption);
    add('yahei', smallTextOf(it));         // 来源小字
    add('yahei', it.caption);              // 索引表里的名称
  });
  // 页眉页脚、索引标题、封面标签等装饰性文字
  add('yahei', TITLE);
  add('yahei', `${DEPT}    第 0 页 / 共 0 页`);
  add('yahei', '0123456789');
  add('heiti', '附录　照片索引表（0/0）');
  add('yahei', '序号　文件名');

  // ---- 字体子集化（必须先于渲染：内容流要按子集的 CID 编码文字）
  const fontKeys = ['yahei', 'yaheiBold', 'heiti', 'songti'];
  const usedChars = new Set();
  const subsets = {};
  for (const key of fontKeys) {
    const set = chars[key];
    for (const ch of set) usedChars.add(ch);
    const sub = loadFont(key).subset(set);
    subsets[key] = sub;
    fontMaps[key] = sub;   // 供 encodeText 使用
  }

  // 索引表排版参数（用于预计算截断后的文本，保证用字与最终渲染一致）
  const perPage = 34;
  const colCount = 2;
  const colW = (A4.w - MARGIN * 2) / colCount;
  const indexRows = items.map((it) => ({ seq: String(it.seq), cap: it.caption }));
  const indexPages = Math.ceil(indexRows.length / (perPage * colCount));
  const indexHigh = A4.h - MARGIN - 30 - 26;   // 索引表首行 y

  /** 按可用宽度自动定字号 / 截断，返回最终文本与字号（渲染与用字收集共用） */
  function fitText(txt, avail, startSize, minSize) {
    let size = startSize;
    while (measure(txt, 'yahei', size) > avail && size > minSize) size -= 0.25;
    if (measure(txt, 'yahei', size) > avail) {
      let t = txt;
      while (t.length > 1 && measure(t + '…', 'yahei', size) > avail) t = t.slice(0, -1);
      return { txt: t + '…', size };
    }
    return { txt, size };
  }
  /** 预计算索引表里每个名称最终显示的文本 */
  const indexFit = indexRows.map((r) => fitText(r.cap, colW - 26, 8, 5.5).txt);
  indexFit.forEach((t) => add('yahei', t));

  // ---- 开始排版
  const writer = new PdfWriter();
  const pagesContent = [];
  const headerText = TITLE;
  const footerLeft = DEPT;

  // 页面通用装饰（页眉 / 页脚）
  function decorate(c, pageNo, total) {
    const cGray = [110, 110, 110];
    c.line(MARGIN, A4.h - MARGIN + 14, A4.w - MARGIN, A4.h - MARGIN + 14, [175, 175, 175], 0.5);
    const hw = measure(headerText, 'yahei', 9);
    c.text('F_yahei', 9, cGray, A4.w - MARGIN - hw, A4.h - MARGIN + 20, headerText);
    const ft = `${footerLeft}    第 ${pageNo} 页 / 共 ${total} 页`;
    const fw = measure(ft, 'yahei', 9);
    c.text('F_yahei', 9, cGray, (A4.w - fw) / 2, MARGIN - 24, ft);
  }

  // ---- 1) 封面
  {
    const c = new Content();
    const cx = A4.w / 2;
    let y = A4.h - MARGIN - 150;
    const pw = measure(PROJECT, 'yahei', 11);
    c.text('F_yahei', 11, [110, 110, 110], cx - pw / 2, y, PROJECT);
    y -= 46;
    const tw = measure(TITLE, 'yaheiBold', 28);
    c.text('F_yaheiBold', 28, [31, 56, 100], cx - tw / 2, y, TITLE);
    y -= 34;
    const st = '现场施工情况照片汇编';
    const sw = measure(st, 'yahei', 14);
    c.text('F_yahei', 14, [90, 90, 90], cx - sw / 2, y, st);
    y -= 26;
    c.line(MARGIN + 60, y, A4.w - MARGIN - 60, y, [150, 150, 150], 0.8);

    y -= 60;
    const labelX = MARGIN + 60;
    const valueX = labelX + 90;
    for (const [k, v] of infoRows) {
      c.text('F_yahei', 10.5, [70, 70, 70], labelX, y, `${k}：`);
      // 值过长时按可用宽度收紧字号
      const avail = A4.w - MARGIN - valueX;
      let size = 10.5;
      let vw = measure(v, 'yahei', size);
      while (vw > avail && size > 7) { size -= 0.25; vw = measure(v, 'yahei', size); }
      c.text('F_yahei', size, [20, 20, 20], valueX, y, v);
      y -= 34;
    }

    const note = '本图集用于现场情况说明与内部沟通，照片内容以原始文件为准。';
    const nw = measure(note, 'songti', 10);
    c.text('F_songti', 10, [120, 120, 120], cx - nw / 2, MARGIN + 60, note);
    pagesContent.push(c);
  }

  // ---- 2) 每页一图
  for (const it of items) {
    const c = new Content();
    const top = A4.h - MARGIN;
    const bottom = MARGIN;
    const capH = 40;   // 图注区高度
    const availH = top - bottom - capH - 30;
    let h = it.dispH;
    let w = it.dispW;
    if (h > availH) { h = availH; w = h * (it.width / it.height); }
    const x = (A4.w - w) / 2;
    const y = bottom + capH + 20;
    c.image(`Im${it.seq}`, x, y, w, h);
    const capText = `图 ${it.seq}　${it.caption}`;
    const cw = measure(capText, 'heiti', 11.5);
    c.text('F_heiti', 11.5, [70, 70, 70], (A4.w - cw) / 2, bottom + 14, capText);
    const smallText = smallTextOf(it);
    const smw = measure(smallText, 'yahei', 7.5);
    c.text('F_yahei', 7.5, [150, 150, 150], (A4.w - smw) / 2, bottom - 6, smallText);
    pagesContent.push(c);
  }

  // ---- 3) 附录：照片索引表
  for (let p = 0; p < indexPages; p++) {
    const c = new Content();
    let y = A4.h - MARGIN - 30;
    const heading = `附录　照片索引表（${p + 1}/${indexPages}）`;
    c.text('F_heiti', 13, [31, 70, 122], MARGIN, y, heading);
    y -= 26;
    for (let col = 0; col < colCount; col++) {
      const x = MARGIN + col * colW;
      let yy = y;
      c.text('F_yahei', 8, [120, 120, 120], x, yy, '序号　文件名');
      yy -= 13;
      for (let r = 0; r < perPage; r++) {
        const idx = p * perPage * colCount + col * perPage + r;
        if (idx >= indexRows.length) break;
        c.text('F_yahei', 8, [40, 40, 40], x, yy, indexRows[idx].seq);
        c.text('F_yahei', 8, [40, 40, 40], x + 24, yy, indexFit[idx]);
        yy -= 13;
      }
    }
    pagesContent.push(c);
  }
  void indexHigh;

  // ---- 5) 写入 PDF 对象
  writer.rootRef = 'PLACEHOLDER';
  writer.infoRef = 'PLACEHOLDER';

  const fontObjNums = {};
  const fontResRefs = {};
  for (const key of fontKeys) {
    const sub = subsets[key];
    const fontFileNum = writer.addStream(
      { Filter: '/FlateDecode', Length1: sub.buffer.length },
      zlibDeflate(sub.buffer)
    );

    // CIDToGIDMap：2 字节/CID。
    // 子集里 CID 就是新字体的字形序号（subset() 按码点顺序分配 CID 并同步重排 glyf/loca），
    // 因此映射必须是「恒等映射」；若这里写成原字体的 gid，文字会指向错误的字形。
    const c2g = Buffer.alloc(sub.cidToGid.length * 2);
    for (let cid = 0; cid < sub.cidToGid.length; cid++) {
      c2g.writeUInt16BE(cid, cid * 2);
    }
    const c2gNum = writer.addStream({ Filter: '/FlateDecode' }, zlibDeflate(c2g));

    const descNum = writer.addObject(
      formatDict({
        Type: '/FontDescriptor',
        FontName: `/KMSubset+${key}`,
        Flags: 4,
        FontBBox: '[-200 -300 1200 1000]',
        ItalicAngle: 0,
        Ascent: 880,
        Descent: -220,
        CapHeight: 700,
        StemV: 80,
        FontFile2: `${fontFileNum} 0 R`,
      })
    );

    const cidFontNum = writer.addObject(
      formatDict({
        Type: '/Font',
        Subtype: '/CIDFontType2',
        BaseFont: `/KMSubset+${key}`,
        CIDSystemInfo: '<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>',
        FontDescriptor: `${descNum} 0 R`,
        DW: 1000,
        CIDToGIDMap: `${c2gNum} 0 R`,
      })
    );

    const toUni = buildToUnicode(sub, fontKeys, key);
    const toUniNum = writer.addStream({ Filter: '/FlateDecode' }, zlibDeflate(Buffer.from(toUni, 'latin1')));

    const type0Num = writer.addObject(
      formatDict({
        Type: '/Font',
        Subtype: '/Type0',
        BaseFont: `/KMSubset+${key}`,
        Encoding: '/Identity-H',
        DescendantFonts: `[${cidFontNum} 0 R]`,
        ToUnicode: `${toUniNum} 0 R`,
      })
    );
    fontObjNums[key] = type0Num;
    fontResRefs[key] = `/F_${key} ${type0Num} 0 R`;
  }

  // ---- 图片 XObject
  const imageXObjects = {};
  for (const it of items) {
    const data = fs.readFileSync(it.full);
    const colorSpace = it.comps === 1 ? '/DeviceGray' : it.comps === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    const num = writer.addStream(
      {
        Type: '/XObject',
        Subtype: '/Image',
        Width: it.width,
        Height: it.height,
        ColorSpace: colorSpace,
        BitsPerComponent: 8,
        Filter: '/DCTDecode',
      },
      data
    );
    imageXObjects[it.seq] = num;
  }

  // ---- 页面对象
  const totalPages = pagesContent.length;
  const pageObjNums = [];
  const pagesObjNum = writer.alloc();

  pagesContent.forEach((content, i) => {
    decorate(content, i + 1, totalPages);
    const resParts = [`/Font << ${Object.values(fontResRefs).join(' ')} >>`];
    const xo = items.map((it) => `/Im${it.seq} ${imageXObjects[it.seq]} 0 R`).join(' ');
    resParts.push(`/XObject << ${xo} >>`);
    const resNum = writer.addObject(`<< ${resParts.join(' ')} >>`);
    const stream = content.toString();
    const contNum = writer.addStream({ Filter: '/FlateDecode' }, zlibDeflate(Buffer.from(stream, 'latin1')));
    const pageNum = writer.addObject(
      `<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 ${A4.w.toFixed(2)} ${A4.h.toFixed(2)}] ` +
      `/Resources ${resNum} 0 R /Contents ${contNum} 0 R >>`
    );
    pageObjNums.push(pageNum);
  });

  writer.set(
    pagesObjNum,
    `<< /Type /Pages /Count ${pageObjNums.length} /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] >>`
  );

  const catalogNum = writer.addObject(`<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`);
  const infoNum = writer.addObject(
    `<< /Title ${pdfString(TITLE)} /Author ${pdfString(DEPT)} /Subject ${pdfString('现场施工情况照片汇编')} ` +
    `/Creator ${pdfString('总经办文档库 · generate_photo_album_pdf.js')} /Producer ${pdfString('Node zero-dep PDF writer')} >>`
  );
  writer.rootRef = `${catalogNum} 0 R`;
  writer.infoRef = `${infoNum} 0 R`;

  const pdf = writer.serialize();

  const outFull = path.resolve(OUT);
  fs.mkdirSync(path.dirname(outFull), { recursive: true });
  fs.writeFileSync(outFull, pdf);

  console.log('源目录    ：' + SRC);
  console.log('照片数量  ：' + items.length);
  console.log('页面总数  ：' + totalPages + `（封面 1 + 照片 ${items.length} + 索引 ${totalPages - items.length - 1}）`);
  console.log('用字数量  ：' + usedChars.size);
  console.log('字体子集  ：' + fontKeys.map((k) => `${k}=${(subsets[k].buffer.length / 1024).toFixed(1)}KB`).join(' '));
  console.log('文件大小  ：' + (pdf.length / 1048576).toFixed(2) + ' MB');
  console.log('输出      ：' + outFull);
}

// 字形宽度度量（用于居中）：先按字体真实 advance 求和
function measure(str, fontKey, size) {
  const font = loadFont(fontKey);
  let w = 0;
  for (const ch of str) {
    const gid = font.gidFor(ch.codePointAt(0));
    w += (font.advance[gid] || font.unitsPerEm) / font.unitsPerEm;
  }
  return w * size;
}

function buildToUnicode(sub, fontKeys, key) {
  // 反查：cid -> unicode（从该字体实际用字生成）
  const font = loadFont(key);
  const entries = [];
  for (const [cp, gid] of font.map.entries()) {
    const cid = sub.gidToCid.get(gid);
    if (cid) entries.push([cid, cp]);
  }
  entries.sort((a, b) => a[0] - b[0]);
  const parts = [];
  parts.push('/CIDInit /ProcSet findresource begin');
  parts.push('12 dict begin');
  parts.push('begincmap');
  parts.push('/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def');
  parts.push('/CMapName /Adobe-Identity-UCS def');
  parts.push('/CMapType 2 def');
  parts.push('1 begincodespacerange');
  parts.push('<0000> <FFFF>');
  parts.push('endcodespacerange');
  // 每段最多 100 条
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    parts.push(`${chunk.length} beginbfchar`);
    for (const [cid, cp] of chunk) {
      const hex = cp.toString(16).toUpperCase().padStart(4, '0');
      parts.push(`<${cid.toString(16).toUpperCase().padStart(4, '0')}> <${hex}>`);
    }
    parts.push('endbfchar');
  }
  parts.push('endcmap');
  parts.push('CMapName currentdict /CMap defineresource pop');
  parts.push('end');
  parts.push('end');
  return parts.join('\n');
}

let zlib;
function zlibDeflate(buf) {
  if (!zlib) zlib = require('zlib');
  return zlib.deflateSync(buf, { level: 9 });
}

// ================================================================ 执行
try {
  main();
} catch (err) {
  console.error('[失败] ' + err.message);
  if (process.env.PDF_ALBUM_DEBUG) console.error(err.stack);
  process.exit(1);
}
