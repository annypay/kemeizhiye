#!/usr/bin/env node
/**
 * check_repo.js — 文档仓库卫生校验
 * 用法: node scripts/check_repo.js [--staged]
 * 检查项：下载重复后缀 (1)(2)(3)、Office 临时文件 ~$*、bak 备份、
 *         同名目录嵌套、>10MB 大文件、根目录散文件、日期格式不一致目录。
 * 默认扫描全库；--staged 仅检查本次暂存的新建和修改文件。
 */
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const issues = [];
const stagedOnly = process.argv.includes('--staged');
const allowedDirs = /^(0\d-|_archive$|scripts$|参考资料$|\.git$|\.github$)/;
const allowedRootFiles = ['README.md', 'INDEX.md', 'AGENTS.md', '.gitignore', '.markdownlint.json'];

function run(cmd) {
  try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { return ''; }
}

const fileCommand = stagedOnly
  ? 'git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMR'
  : 'git -c core.quotePath=false ls-files';
const files = run(fileCommand).trim().split('\n').filter(Boolean);

function fileSize(file) {
  if (stagedOnly) {
    try {
      return Number(execFileSync('git', ['cat-file', '-s', ':' + file], { cwd: ROOT, encoding: 'utf8' }).trim());
    } catch (e) {
      return 0;
    }
  }

  try {
    return fs.statSync(path.join(ROOT, file)).size;
  } catch (e) {
    return 0;
  }
}

for (const f of files) {
  const base = path.basename(f);
  // 下载重复后缀
  if (/[(（]\d+[)）]/.test(base)) issues.push(`[重复下载后缀] ${f}`);
  // bak 备份
  if (/bak/i.test(base)) issues.push(`[bak 备份] ${f}`);
  // Office 临时
  if (base.startsWith('~$')) issues.push(`[Office 临时] ${f}`);
  if (stagedOnly && base.endsWith('.zip')) issues.push(`[冗余zip] ${f}`);
  const size = fileSize(f);
  if (size > 10 * 1024 * 1024) issues.push(`[大文件 ${(size / 1048576).toFixed(1)}MB] ${f}`);
}

if (!stagedOnly) {
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
        if (fs.existsSync(path.join(p, en.name))) issues.push(`[同名嵌套目录] ${r}/${en.name}/`);
      } else {
        if (en.name.startsWith('~$')) issues.push(`[Office 临时(磁盘)] ${r}`);
        if (/\.bak$/i.test(en.name)) issues.push(`[bak(磁盘)] ${r}`);
        if (en.name.endsWith('.zip')) issues.push(`[冗余zip(磁盘)] ${r}`);
      }
    }
  }
  walk(ROOT, '');
}

if (stagedOnly) {
  // 3. 暂存文件的根路径（不扫描无关的工作区内容）
  const invalidRootDirs = new Set();
  files.forEach(file => {
    const parts = file.split('/');
    if (parts.length === 1) {
      if (!allowedRootFiles.includes(parts[0])) issues.push(`[根目录散文件] ${parts[0]}`);
    } else if (!allowedDirs.test(parts[0])) {
      invalidRootDirs.add(parts[0]);
    }
  });
  invalidRootDirs.forEach(dir => issues.push(`[根目录非规范目录] ${dir}/`));
} else {
  // 3. 根目录散文件（只允许 00-09 目录、参考资料、_archive、scripts、.github、README/INDEX/AGENTS/.gitignore/.git）
  const topLevel = fs.readdirSync(ROOT);
  for (const en of topLevel) {
    const isDir = fs.statSync(path.join(ROOT, en)).isDirectory();
    if (isDir) {
      if (!allowedDirs.test(en)) issues.push(`[根目录非规范目录] ${en}/`);
    } else if (!allowedRootFiles.includes(en)) {
      issues.push(`[根目录散文件] ${en}`);
    }
  }
}

// 4. 日期格式不一致目录（仅检查正式区 0X- 目录，_archive 允许描述性命名）
const dirs = run('git -c core.quotePath=false ls-files').trim().split('\n').filter(f => f.includes('/') && !f.startsWith('_archive/')).map(f => f.split('/')[1]).filter(Boolean);
const uniq = [...new Set(dirs)];
const badDateDirs = uniq.filter(d => /^\d/.test(d) && !/^\d{4}(\.\d{2}|\d{4}|-\d{2}-\d{2})/.test(d));
for (const d of badDateDirs) issues.push(`[日期目录格式] 一级子目录 "${d}" 建议统一为 YYYY-MM 或 YYYYMMDD`);

// 输出
if (issues.length === 0) {
  console.log(`OK ${stagedOnly ? '暂存区' : '仓库'}卫生检查通过：${stagedOnly && files.length === 0 ? '无待检查文件' : '无违规项'}`);
  process.exit(0);
}
console.log(`发现 ${issues.length} 个${stagedOnly ? '暂存区' : '仓库'}违规项：`);
issues.forEach(i => console.log('  ' + i));
process.exit(1);
