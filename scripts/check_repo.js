#!/usr/bin/env node
/**
 * check_repo.js — 文档仓库卫生校验
 * 用法: node scripts/check_repo.js
 * 检查项：下载重复后缀 (1)(2)(3)、Office 临时文件 ~$*、bak 备份、
 *         同名目录嵌套、>10MB 大文件、根目录散文件、日期格式不一致目录。
 * 输出违规清单；无违规时输出 OK。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const issues = [];

function run(cmd) {
  try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { return ''; }
}

// 1. git 追踪文件检查
const files = run('git -c core.quotePath=false ls-files').trim().split('\n').filter(Boolean);

for (const f of files) {
  const base = path.basename(f);
  // 下载重复后缀
  if (/[(（]\d+[)）]/.test(base)) issues.push(`[重复下载后缀] ${f}`);
  // bak 备份
  if (/bak/i.test(base)) issues.push(`[bak 备份] ${f}`);
  // Office 临时
  if (base.startsWith('~$')) issues.push(`[Office 临时] ${f}`);
  // 大文件
  const full = path.join(ROOT, f);
  try {
    const st = fs.statSync(full);
    if (st.size > 10 * 1024 * 1024) issues.push(`[大文件 ${(st.size / 1048576).toFixed(1)}MB] ${f}`);
  } catch (e) {}
}

// 2. 磁盘上的 ~$ / bak（git 忽略的也算）
function walk(dir, rel) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const en of entries) {
    if (en.name === '.git' || en.name === 'node_modules' || en.name === 'scripts') continue;
    const p = path.join(dir, en.name);
    const r = rel ? rel + '/' + en.name : en.name;
    if (en.isDirectory()) {
      walk(p, r);
      // 同名嵌套目录
      if (fs.existsSync(path.join(p, en.name))) issues.push(`[同名嵌套目录] ${r}/${en.name}/`);
    } else {
      if (en.name.startsWith('~$')) issues.push(`[Office 临时(磁盘)] ${r}`);
      if (/\.bak$/i.test(en.name)) issues.push(`[bak(磁盘)] ${r}`);
      if (en.name.endsWith('.zip')) issues.push(`[冗余zip(磁盘)] ${r}`);
    }
  }
}
walk(ROOT, '');

// 3. 根目录散文件（只允许 00-09 目录、参考资料、_archive、scripts、README/INDEX/.gitignore/.git）
const topLevel = fs.readdirSync(ROOT);
const allowedDirs = /^(0\d-|_archive$|scripts$|参考资料$|\.git$)/;
for (const en of topLevel) {
  const isDir = fs.statSync(path.join(ROOT, en)).isDirectory();
  if (isDir) {
    if (!allowedDirs.test(en)) issues.push(`[根目录非规范目录] ${en}/`);
  } else {
    if (!['README.md', 'INDEX.md', '.gitignore'].includes(en)) issues.push(`[根目录散文件] ${en}`);
  }
}

// 4. 日期格式不一致目录（仅检查正式区 0X- 目录，_archive 允许描述性命名）
const dirs = run('git -c core.quotePath=false ls-files').trim().split('\n').filter(f => f.includes('/') && !f.startsWith('_archive/')).map(f => f.split('/')[1]).filter(Boolean);
const uniq = [...new Set(dirs)];
const badDateDirs = uniq.filter(d => /^\d/.test(d) && !/^\d{4}(\.\d{2}|\d{4}|-\d{2}-\d{2})/.test(d));
for (const d of badDateDirs) issues.push(`[日期目录格式] 一级子目录 "${d}" 建议统一为 YYYY-MM 或 YYYYMMDD`);

// 输出
if (issues.length === 0) {
  console.log('OK 仓库卫生检查通过：无违规项');
  process.exit(0);
}
console.log(`发现 ${issues.length} 个违规项：`);
issues.forEach(i => console.log('  ' + i));
process.exit(1);
