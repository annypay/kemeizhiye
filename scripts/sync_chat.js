#!/usr/bin/env node
/**
 * sync_chat.js — Copilot 会话与记忆的仓库化同步
 * 用法:
 *   node scripts/sync_chat.js --status            查看两侧会话数量与时间
 *   node scripts/sync_chat.js --export [--full]   VS Code 存储 → 仓库 _会话记录/
 *   node scripts/sync_chat.js --import [--full]   仓库 _会话记录/ → VS Code 存储
 * 选项:
 *   --full    连同 transcripts / chat-session-resources 一起同步（体积更大）
 *   --force   导入时覆盖本机更新的文件
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const ROOT = path.resolve(__dirname, '..');
const STORE = path.join(ROOT, '_会话记录');
const args = process.argv.slice(2);
const full = args.includes('--full');
const force = args.includes('--force');

// 仓库侧目录名 → VS Code workspaceStorage 内的相对路径
const BASE_SETS = [
  { repo: 'chatSessions', storage: ['chatSessions'] },
  { repo: 'memories', storage: ['GitHub.copilot-chat', 'memory-tool', 'memories'] },
];
const FULL_SETS = [
  { repo: 'transcripts', storage: ['GitHub.copilot-chat', 'transcripts'] },
  { repo: 'chat-session-resources', storage: ['GitHub.copilot-chat', 'chat-session-resources'] },
];

function userDirs() {
  const home = os.homedir();
  const names = ['Code', 'Code - Insiders'];
  let bases;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    bases = names.map(n => path.join(appData, n, 'User'));
  } else if (process.platform === 'darwin') {
    bases = names.map(n => path.join(home, 'Library', 'Application Support', n, 'User'));
  } else {
    bases = names.map(n => path.join(home, '.config', n, 'User'));
  }
  return bases.filter(p => fs.existsSync(p));
}

function samePath(a, b) {
  const norm = p => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

function findStorageDir() {
  for (const user of userDirs()) {
    const wsRoot = path.join(user, 'workspaceStorage');
    if (!fs.existsSync(wsRoot)) continue;
    for (const entry of fs.readdirSync(wsRoot)) {
      const meta = path.join(wsRoot, entry, 'workspace.json');
      if (!fs.existsSync(meta)) continue;
      let folder;
      try { folder = JSON.parse(fs.readFileSync(meta, 'utf8')).folder; } catch (e) { continue; }
      if (!folder) continue;
      let resolved;
      try { resolved = fileURLToPath(folder); } catch (e) { continue; }
      if (samePath(resolved, ROOT)) return path.join(wsRoot, entry);
    }
  }
  return null;
}

function copyTree(src, dst, stats) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, stats);
      continue;
    }
    const srcStat = fs.statSync(from);
    if (fs.existsSync(to)) {
      const dstStat = fs.statSync(to);
      // 内容一致就不改写，避免无谓覆盖正在使用的会话文件
      if (dstStat.size === srcStat.size && fs.readFileSync(from).equals(fs.readFileSync(to))) { stats.skipped++; continue; }
      if (!force && dstStat.mtimeMs > srcStat.mtimeMs) { stats.newer++; continue; }
    }
    fs.copyFileSync(from, to);
    fs.utimesSync(to, srcStat.atime, srcStat.mtime);
    stats.copied++;
  }
}

function countTree(dir) {
  if (!fs.existsSync(dir)) return { files: 0, bytes: 0, latest: 0 };
  let files = 0, bytes = 0, latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = countTree(p);
      files += sub.files; bytes += sub.bytes; latest = Math.max(latest, sub.latest);
    } else {
      const st = fs.statSync(p);
      files++; bytes += st.size; latest = Math.max(latest, st.mtimeMs);
    }
  }
  return { files, bytes, latest };
}

function describe(dir) {
  const c = countTree(dir);
  const when = c.latest ? new Date(c.latest).toISOString().slice(0, 16).replace('T', ' ') : '—';
  return `${c.files} 个文件 / ${(c.bytes / 1048576).toFixed(2)} MB / 最近 ${when}`;
}

function main() {
  const mode = args.find(a => ['--status', '--export', '--import'].includes(a));
  if (!mode) {
    console.log('用法: node scripts/sync_chat.js --status | --export | --import [--full] [--force]');
    process.exit(1);
  }

  const storage = findStorageDir();
  if (!storage) {
    console.error('未找到本工作区的 VS Code 会话存储目录。');
    console.error('请先用 VS Code 打开本仓库文件夹（至少一次），再重新运行本命令。');
    process.exit(1);
  }

  const sets = full ? BASE_SETS.concat(FULL_SETS) : BASE_SETS;

  if (mode === '--status') {
    console.log('VS Code 存储目录: ' + storage);
    console.log('仓库会话目录:     ' + STORE);
    for (const set of sets) {
      const live = path.join(storage, ...set.storage);
      console.log(`  ${set.repo}`);
      console.log(`    VS Code: ${describe(live)}`);
      console.log(`    仓库:    ${describe(path.join(STORE, set.repo))}`);
    }
    return;
  }

  const stats = { copied: 0, skipped: 0, newer: 0 };
  for (const set of sets) {
    const live = path.join(storage, ...set.storage);
    const repo = path.join(STORE, set.repo);
    if (mode === '--export') copyTree(live, repo, stats);
    else copyTree(repo, live, stats);
  }

  const direction = mode === '--export' ? 'VS Code → 仓库' : '仓库 → VS Code';
  console.log(`OK ${direction}：复制 ${stats.copied}，跳过 ${stats.skipped}${stats.newer ? `，保留本机较新 ${stats.newer}（加 --force 可覆盖）` : ''}`);
  if (mode === '--import' && stats.copied > 0) {
    console.log('提示：重新加载 VS Code 窗口后，历史会话才会出现在 Chat 面板。');
  }
}

main();
