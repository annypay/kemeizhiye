#!/usr/bin/env node
/**
 * gen_index.js — 自动生成 INDEX.md 全文索引
 * 用法: node scripts/gen_index.js
 * 扫描 git 追踪的全部文件（含 _archive），按目录输出索引。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'INDEX.md');

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function main() {
  const files = run('git -c core.quotePath=false ls-files').trim().split('\n').filter(Boolean);
  const now = new Date();
  const tree = new Map(); // dirPath -> [{name, size, mtime}]

  for (const f of files) {
    const full = path.join(ROOT, f);
    let size = 0, mtime = '';
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtime.toISOString().slice(0, 10);
    } catch (e) { /* 文件可能被忽略但仍在索引 */ }
    const dir = path.dirname(f) === '.' ? '（根目录）' : path.dirname(f);
    if (!tree.has(dir)) tree.set(dir, []);
    tree.get(dir).push({ name: path.basename(f), size, mtime });
  }

  const dirs = [...tree.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const lines = [];
  lines.push('# 总经办文档 · 全文索引');
  lines.push('');
  lines.push(`> 自动生成：\`node scripts/gen_index.js\` ｜ 生成时间：${now.toISOString().slice(0, 16).replace('T', ' ')}`);
  lines.push(`> 共 ${files.length} 个文件。目录分类导航见 \`README.md\`，本索引按目录逐一列出文件。`);
  lines.push('');
  lines.push('## 目录速览');
  lines.push('');
  for (const d of dirs) {
    const count = tree.get(d).length;
    lines.push(`- [${d}](#${d.replace(/[（）()/.\s]/g, '')})（${count} 个文件）`);
  }
  lines.push('');
  for (const d of dirs) {
    lines.push(`## ${d}`);
    lines.push('');
    lines.push('| 文件 | 大小 | 修改日期 |');
    lines.push('| --- | --- | --- |');
    for (const f of tree.get(d).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      lines.push(`| \`${f.name}\` | ${fmtSize(f.size)} | ${f.mtime} |`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('*本文件由脚本生成，请勿手工编辑；文件增删后运行 `node scripts/gen_index.js` 重新生成。*');
  fs.writeFileSync(OUT, lines.join('\n').replace(/\n+$/, '') + '\n', 'utf8');
  console.log('OK INDEX.md written:', files.length, 'files,', dirs.length, 'directories');
}

main();
