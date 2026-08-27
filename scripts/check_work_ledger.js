#!/usr/bin/env node
/**
 * check_work_ledger.js — 工作事项总台账结构与闭环校验
 * 用法: node scripts/check_work_ledger.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEDGER_REL = '04-进度督察/工作台账/工作事项总台账.md';
const LEDGER = path.join(ROOT, LEDGER_REL);
const START_MARKER = '<!-- WORK-LEDGER:START -->';
const END_MARKER = '<!-- WORK-LEDGER:END -->';
const HEADERS = ['事项编号', '状态', '来源', '事项', '责任单位/人', '截止日', '最近更新', '复查日', '证据/归档', '说明/下一步'];
const STATUSES = new Set(['待确认', '进行中', '待复查', '已关闭', '暂缓', '已撤销']);

function cellValue(value) {
  return value.replace(/`/g, '').trim();
}

function isBlank(value) {
  return ['', '-', '—', '无', '暂无', '待明确'].includes(cellValue(value));
}

function isIsoDate(value) {
  const normalized = cellValue(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  const date = new Date(normalized + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === normalized;
}

function tableCells(line) {
  const normalized = line.trim();
  if (!normalized.startsWith('|') || !normalized.endsWith('|')) return null;
  return normalized.slice(1, -1).split('|').map(cell => cell.trim());
}

function isSeparator(cells) {
  return cells && cells.length === HEADERS.length && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function main() {
  const issues = [];
  const rows = [];

  if (!fs.existsSync(LEDGER)) {
    issues.push(`[缺少台账] ${LEDGER_REL}`);
  } else {
    const content = fs.readFileSync(LEDGER, 'utf8');
    const start = content.indexOf(START_MARKER);
    const end = content.indexOf(END_MARKER);

    if (start === -1 || end === -1 || end <= start) {
      issues.push(`[数据区标记错误] ${LEDGER_REL}`);
    } else {
      const lines = content.slice(start + START_MARKER.length, end).split(/\r?\n/);
      const firstLine = lines.findIndex(line => line.trim() !== '');

      if (firstLine === -1) {
        issues.push('[台账为空] 数据区未找到表头');
      } else {
        const headers = tableCells(lines[firstLine]);
        if (!headers || headers.join('|') !== HEADERS.join('|')) {
          issues.push(`[表头错误] 必须为：${HEADERS.join(' / ')}`);
        } else {
          let lineIndex = firstLine + 1;
          while (lineIndex < lines.length && lines[lineIndex].trim() === '') lineIndex += 1;

          if (!isSeparator(tableCells(lines[lineIndex] || ''))) {
            issues.push('[表格分隔行错误] 表头后必须保留 Markdown 分隔行');
          } else {
            for (lineIndex += 1; lineIndex < lines.length; lineIndex += 1) {
              const line = lines[lineIndex].trim();
              if (!line) continue;

              const cells = tableCells(line);
              if (!cells) {
                issues.push(`[数据区非表格内容] 第 ${lineIndex + 1} 行：${line}`);
                continue;
              }
              if (cells.length !== HEADERS.length) {
                issues.push(`[列数错误] 第 ${lineIndex + 1} 行应有 ${HEADERS.length} 列，实际 ${cells.length} 列`);
                continue;
              }

              rows.push(Object.fromEntries(HEADERS.map((header, index) => [header, cells[index]])));
            }
          }
        }
      }
    }
  }

  if (rows.length === 0 && issues.length === 0) issues.push('[台账为空] 至少应保留一条事项记录');

  const ids = new Set();
  rows.forEach((row, index) => {
    const label = `第 ${index + 1} 条`;
    const id = cellValue(row['事项编号']);
    const status = cellValue(row['状态']);

    if (!/^JK-RW-\d{4}-\d{4}$/.test(id)) issues.push(`[事项编号格式] ${label}：${id || '为空'}`);
    if (ids.has(id)) issues.push(`[事项编号重复] ${id}`);
    ids.add(id);
    if (!STATUSES.has(status)) issues.push(`[状态非法] ${label}：${status || '为空'}`);
    ['来源', '事项', '最近更新'].forEach(field => {
      if (isBlank(row[field])) issues.push(`[必填字段为空] ${label}：${field}`);
    });
    if (!isBlank(row['最近更新']) && !isIsoDate(row['最近更新'])) {
      issues.push(`[最近更新格式] ${label}：必须为 YYYY-MM-DD`);
    }
    if (status === '已关闭') {
      if (!isIsoDate(row['复查日'])) issues.push(`[关闭缺少复查日] ${label}`);
      if (isBlank(row['证据/归档'])) issues.push(`[关闭缺少证据/归档] ${label}`);
    }
    if ((status === '暂缓' || status === '已撤销') && isBlank(row['说明/下一步'])) {
      issues.push(`[${status}缺少说明] ${label}`);
    }
  });

  if (issues.length > 0) {
    console.error(`FAIL 工作事项总台账校验未通过：${issues.length} 项`);
    issues.forEach(issue => console.error('  ' + issue));
    process.exit(1);
  }

  const statusSummary = [...STATUSES]
    .map(status => `${status} ${rows.filter(row => cellValue(row['状态']) === status).length}`)
    .join('，');
  console.log(`OK 工作事项总台账校验通过：${rows.length} 项（${statusSummary}）`);
}

main();