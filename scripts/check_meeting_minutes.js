#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { deriveArchiveWeek, parseIsoDate } = require("./create_meeting_package");

const ROOT = path.resolve(__dirname, "..");
const PENDING = "pending";
const META_KEYS = [
  "meeting_date",
  "archive_week",
  "report_period",
  "plan_period",
  "report_cutoff",
  "summary_source",
  "roster_source",
  "audio_source",
  "transcript_source",
  "signed_at",
];
const SOURCE_KEYS = ["summary_source", "roster_source", "audio_source", "transcript_source"];
const VARIANTS = [
  { key: "chairman", suffix: "董事长版" },
  { key: "generalManager", suffix: "总经理版" },
  { key: "group", suffix: "完整版（群发）" },
];

function parseMetadata(content) {
  const match = content.match(/<!--\s*MEETING-MINUTES-META\s*\r?\n([\s\S]*?)-->/);
  if (!match) return null;
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    metadata[key] = value;
  }
  return metadata;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSection(content, title) {
  const expression = new RegExp(`^##\\s+[一二三四五六七八九十]+、${escapeRegularExpression(title)}[^\\n]*$`, "m");
  const match = expression.exec(content);
  if (!match) return null;
  const start = match.index + match[0].length;
  const nextHeading = content.indexOf("\n## ", start);
  return content.slice(start, nextHeading === -1 ? content.length : nextHeading);
}

function getSectionByTitles(content, titles) {
  for (const title of titles) {
    const section = getSection(content, title);
    if (section !== null) return { title, section };
  }
  return null;
}

function formatArchiveWeekForHeader(archiveWeek) {
  const start = `${archiveWeek.slice(0, 4)}-${archiveWeek.slice(4, 6)}-${archiveWeek.slice(6, 8)}`;
  const end = `${archiveWeek.slice(13, 15)}-${archiveWeek.slice(15, 17)}`;
  return `${start} ～ ${end}`;
}

function getDisplayHeaderLines(content) {
  const lines = content.split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => /^#\s+/.test(line));
  if (titleIndex === -1) return [];
  const headerLines = [];
  for (let index = titleIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    if (!/^>\s+/.test(trimmed)) break;
    headerLines.push(trimmed.replace(/^>\s+/, "").replace(/\*\*/g, "").trim());
  }
  return headerLines;
}

function validateDisplayHeader(content, metadata, archiveWeek, label, errors) {
  const headerLines = getDisplayHeaderLines(content);
  const expectedSubtitle = `江西柯美纸业有限公司 ｜ 周序号 ${archiveWeek} ｜ ${formatArchiveWeekForHeader(archiveWeek)}`;
  const expectedDetails = "主持人：总经办 ｜ 出席：各专业负责人 ｜ 记录/整理：总经办 ｜ 签发：总经办";
  if (headerLines[0] !== expectedSubtitle) {
    errors.push(`${label}的副标题第一行必须为：${expectedSubtitle}`);
  }
  if (headerLines[1] !== expectedDetails) {
    errors.push(`${label}的副标题第二行必须为：${expectedDetails}`);
  }
}

function validateCountdownLine(content, label, errors) {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const withoutQuote = trimmed.replace(/^>\s*/, "");
    if (!withoutQuote.startsWith("**倒计时")) continue;
    if (!/^\*\*倒计时[：:][^*]*\*\*[。.]?$/.test(withoutQuote)) {
      errors.push(`${label}的倒计时行必须整体加粗（**倒计时：…**）：${trimmed}`);
    }
  }
}

function validateHeadingNoDateRange(content, label, errors) {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!/^##\s+/.test(trimmed)) continue;
    if (/（\s*\d{1,2}[.月]\d{1,2}\s*[—\-~至]\s*\d{1,2}[.月]\d{1,2}[^）]*）/.test(trimmed)) {
      errors.push(`${label}的章节标题不得附加具体日期区间：${trimmed}`);
    }
  }
}

function formatChineseDate(isoDate) {
  const date = parseIsoDate(isoDate);
  if (!date) return null;
  return `${date.getUTCFullYear()} 年 ${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日`;
}

function getSignoffDate(content) {
  const signoffStart = content.lastIndexOf("\n---");
  const signoff = signoffStart === -1 ? content : content.slice(signoffStart);
  const matches = [...signoff.matchAll(/(\d{4}) 年 (\d{1,2}) 月 (\d{1,2}) 日/g)];
  if (matches.length === 0) return null;
  const [, year, month, day] = matches[matches.length - 1];
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function validateSignoff(content, metadata, label, mode, errors) {
  if (!metadata.signed_at) return;
  if (metadata.signed_at === PENDING) {
    if (mode === "formal") errors.push(`${label}的 signed_at 在正式纪要中不得为 pending`);
    return;
  }
  const signoffDate = getSignoffDate(content);
  const expectedDate = formatChineseDate(metadata.signed_at);
  if (!signoffDate || signoffDate !== metadata.signed_at) {
    errors.push(`${label}的文末签发日期必须与 signed_at 一致：${expectedDate}`);
  }
}

function getFirstTable(section) {
  const lines = section.split(/\r?\n/);
  const tableLines = [];
  let collecting = false;
  for (const line of lines) {
    if (/^\|.*\|\s*$/.test(line.trim())) {
      collecting = true;
      tableLines.push(line.trim());
    } else if (collecting) {
      break;
    }
  }
  if (tableLines.length < 2) return null;
  const rows = tableLines
    .filter((line) => !/^\|[\s:|-]+\|$/.test(line))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
  if (rows.length === 0) return null;
  return { header: rows[0], rows: rows.slice(1) };
}

function parseNodeDate(value, meetingDate) {
  const isoMatch = value.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const monthDayMatch = value.match(/(?:^|\D)(\d{1,2})[.月](\d{1,2})(?:日|$|\D)/);
  if (!monthDayMatch) return null;
  const meeting = parseIsoDate(meetingDate);
  let year = meeting.getUTCFullYear();
  const month = Number(monthDayMatch[1]);
  const day = Number(monthDayMatch[2]);
  if (month < meeting.getUTCMonth() + 1 - 6) year += 1;
  const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return parseIsoDate(candidate) ? candidate : null;
}

function validateNodeTable(table, expectedColumns, meetingDate, label, errors) {
  if (!table) {
    errors.push(`${label}缺少 Markdown 表格`);
    return;
  }
  if (table.header.length !== expectedColumns || table.rows.some((row) => row.length !== expectedColumns)) {
    errors.push(`${label}表格必须为 ${expectedColumns} 列`);
    return;
  }
  const dates = table.rows.map((row) => parseNodeDate(row[0], meetingDate));
  let previousDate = null;
  let foundUndated = false;
  for (const date of dates) {
    if (!date) {
      foundUndated = true;
      continue;
    }
    if (foundUndated) errors.push(`${label}中未定日期/时限条目必须排在有日期条目之后`);
    if (previousDate && date < previousDate) errors.push(`${label}未按节点日期升序排列`);
    previousDate = date;
  }
}

function validateRequiredStructure(content, variant, metadata, errors) {
  if (variant.key === "chairman") {
    const meetingInfo = getSection(content, "会议信息");
    const nodes = getSection(content, "重点工作时间节点");
    const decisions = getSectionByTitles(content, ["本周重点决策", "本周重点工作"]);
    const chairman = getSection(content, "董事长指示与要求");
    const generalManager = getSection(content, "总经理要求");
    const tracking = getSection(content, "跟踪事项");
    const review = getSection(content, "关联未关闭事项复盘");
    if (!meetingInfo) errors.push("董事长版缺少“会议信息”章节");
    else validateNodeTable(getFirstTable(meetingInfo), 2, metadata.meeting_date, "董事长版会议信息", errors);
    if (!nodes) errors.push("董事长版缺少“重点工作时间节点”章节");
    else validateNodeTable(getFirstTable(nodes), 3, metadata.meeting_date, "董事长版重点工作时间节点", errors);
    if (!decisions) errors.push("董事长版缺少“本周重点决策”或“本周重点工作”章节");
    if (!chairman) errors.push("董事长版缺少“董事长指示与要求”章节");
    if (!generalManager) errors.push("董事长版缺少“总经理要求”章节");
    if (!tracking) errors.push("董事长版缺少“跟踪事项”章节");
    else validateNodeTable(getFirstTable(tracking), 4, metadata.meeting_date, "董事长版跟踪事项", errors);
    if (review) validateNodeTable(getFirstTable(review), 4, metadata.meeting_date, "董事长版关联未关闭事项复盘", errors);
    return;
  }

  if (variant.key === "generalManager") {
    const nodes = getSection(content, "关键时间节点");
    const work = getSectionByTitles(content, ["本周重点决策", "重点工作安排"]);
    const chairman = getSection(content, "董事长指示要点");
    const generalManager = getSection(content, "总经理要求");
    if (!nodes) errors.push("总经理版缺少“关键时间节点”章节");
    else validateNodeTable(getFirstTable(nodes), 3, metadata.meeting_date, "总经理版关键时间节点", errors);
    if (!work) errors.push("总经理版缺少“本周重点决策”或“重点工作安排”章节");
    if (!chairman) errors.push("总经理版缺少“董事长指示要点”章节");
    if (!generalManager) errors.push("总经理版缺少“总经理要求”章节");
    return;
  }

  const chairman = getSection(content, "董事长讲话核心");
  const generalManager = getSection(content, "总经理讲话核心");
  const nodes = getSection(content, "重点工作时间节点");
  const work = getSectionByTitles(content, ["本周重点决策", "本周重点工作"]);
  if (!chairman) errors.push("群发版缺少“董事长讲话核心”章节");
  if (!generalManager) errors.push("群发版缺少“总经理讲话核心”章节");
  if (!nodes) errors.push("群发版缺少“重点工作时间节点”章节");
  else validateNodeTable(getFirstTable(nodes), 2, metadata.meeting_date, "群发版重点工作时间节点", errors);
  if (!work) errors.push("群发版缺少“本周重点决策”或“本周重点工作”章节");
}

function getNodeTableForVariant(content, variant) {
  const title = variant.key === "chairman" ? "重点工作时间节点" : variant.key === "generalManager" ? "关键时间节点" : "重点工作时间节点";
  const section = getSection(content, title);
  return section ? getFirstTable(section) : null;
}

function validateNodeViews(documents, errors) {
  const chairman = documents.get("chairman");
  const generalManager = documents.get("generalManager");
  const group = documents.get("group");
  if (!chairman || !generalManager || !group) return;

  const chairmanTable = getNodeTableForVariant(chairman.content, chairman.variant);
  const generalManagerTable = getNodeTableForVariant(generalManager.content, generalManager.variant);
  const groupTable = getNodeTableForVariant(group.content, group.variant);
  if (!chairmanTable || !generalManagerTable || !groupTable) return;

  if (generalManagerTable.rows.length !== chairmanTable.rows.length) {
    errors.push("总经理版关键时间节点行数必须与董事长版一致");
  }
  if (groupTable.rows.length !== chairmanTable.rows.length) {
    errors.push("群发版重点工作时间节点行数必须与董事长版一致");
  }
  for (let index = 0; index < chairmanTable.rows.length; index += 1) {
    const chairmanRow = chairmanTable.rows[index];
    const managerRow = generalManagerTable.rows[index];
    const groupRow = groupTable.rows[index];
    if (managerRow && managerRow[0] !== chairmanRow[0]) {
      errors.push(`总经理版第 ${index + 1} 条节点日期/时限与董事长版不一致`);
    }
    if (groupRow && groupRow[0] !== chairmanRow[0]) {
      errors.push(`群发版第 ${index + 1} 条节点日期/时限与董事长版不一致`);
    }
    if (managerRow && managerRow[2] !== chairmanRow[2]) {
      errors.push(`总经理版第 ${index + 1} 条节点责任与董事长版不一致`);
    }
  }
}

function expectedFileName(archiveWeek, variant, extension, temporary) {
  const status = temporary ? "【待确认】" : "";
  return `${archiveWeek}-董事长例会纪要-${variant.suffix}${status}.${extension}`;
}

function validateMetadata(metadata, archiveWeek, root, label, mode, errors, warnings) {
  if (!metadata) {
    errors.push(`${label}缺少 MEETING-MINUTES-META 元数据`);
    return;
  }
  for (const key of META_KEYS) {
    if (!metadata[key]) errors.push(`${label}元数据缺少 ${key}`);
  }
  if (!metadata.meeting_date || !parseIsoDate(metadata.meeting_date)) {
    errors.push(`${label}的 meeting_date 必须为 YYYY-MM-DD`);
  } else if (deriveArchiveWeek(metadata.meeting_date) !== archiveWeek) {
    errors.push(`${label}的 meeting_date 不属于目录归档周期 ${archiveWeek}`);
  }
  if (metadata.archive_week !== archiveWeek) errors.push(`${label}的 archive_week 必须为 ${archiveWeek}`);
  if (metadata.report_period !== PENDING) {
    const [start, end, ...rest] = (metadata.report_period ?? "").split("/");
    if (rest.length > 0 || !parseIsoDate(start) || !parseIsoDate(end) || start > end) {
      errors.push(`${label}的 report_period 必须为 YYYY-MM-DD/YYYY-MM-DD 或 pending`);
    }
  } else {
    warnings.push(`${label}的 report_period 待补充`);
  }
  if (metadata.plan_period !== PENDING) {
    const [start, end, ...rest] = (metadata.plan_period ?? "").split("/");
    if (rest.length > 0 || !parseIsoDate(start) || !parseIsoDate(end) || start > end) {
      errors.push(`${label}的 plan_period 必须为 YYYY-MM-DD/YYYY-MM-DD 或 pending`);
    }
  } else {
    warnings.push(`${label}的 plan_period 待补充`);
  }
  if (metadata.report_cutoff !== PENDING && !parseIsoDate(metadata.report_cutoff ?? "")) {
    errors.push(`${label}的 report_cutoff 必须为 YYYY-MM-DD 或 pending`);
  } else if (metadata.report_cutoff === PENDING) {
    warnings.push(`${label}的 report_cutoff 待补充`);
  }
  if (metadata.signed_at && metadata.signed_at !== PENDING && !parseIsoDate(metadata.signed_at)) {
    errors.push(`${label}的 signed_at 必须为 YYYY-MM-DD 或 pending`);
  }
  for (const key of SOURCE_KEYS) {
    const value = metadata[key];
    if (!value || value === PENDING) {
      warnings.push(`${label}的 ${key} 待补充`);
      continue;
    }
    if (path.isAbsolute(value) || !fs.existsSync(path.resolve(root, value))) {
      errors.push(`${label}的 ${key} 未指向仓库内现有文件：${value}`);
    }
  }
}

function checkDocxPair(directory, markdownPath, docxName, errors) {
  const docxPath = path.join(directory, docxName);
  if (!fs.existsSync(docxPath)) {
    errors.push(`缺少与 ${path.basename(markdownPath)} 配套的 Word 文件：${docxName}`);
    return;
  }
  const signature = fs.readFileSync(docxPath).subarray(0, 4).toString("binary");
  if (signature !== "PK\u0003\u0004") errors.push(`${docxName} 不是有效的 DOCX 压缩包`);
  if (fs.statSync(docxPath).mtimeMs < fs.statSync(markdownPath).mtimeMs) {
    errors.push(`${docxName} 早于对应 Markdown，请重新生成或确认 Word 终稿来源`);
  }
}

function getMode(directory, explicitMode) {
  if (explicitMode) return explicitMode;
  return directory.split(path.sep).includes("00-临时存放") ? "temporary" : "formal";
}

function validateMeetingDirectory({ root = ROOT, directory, mode }) {
  const errors = [];
  const warnings = [];
  const resolvedDirectory = path.resolve(directory);
  const archiveWeek = path.basename(resolvedDirectory);
  const effectiveMode = getMode(resolvedDirectory, mode);
  if (!/^(\d{8})-(\d{8})$/.test(archiveWeek)) {
    errors.push(`目录名必须为 YYYYMMDD-YYYYMMDD：${archiveWeek}`);
    return { errors, warnings };
  }
  if (!fs.existsSync(resolvedDirectory) || !fs.statSync(resolvedDirectory).isDirectory()) {
    errors.push(`会议目录不存在：${resolvedDirectory}`);
    return { errors, warnings };
  }

  const entries = fs.readdirSync(resolvedDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith("~$")) errors.push(`存在 Office 锁文件：${entry.name}`);
  }

  const temporary = effectiveMode === "temporary";
  if (!["temporary", "formal"].includes(effectiveMode)) {
    errors.push(`未知校验模式：${effectiveMode}`);
    return { errors, warnings };
  }

  const markdownByVariant = new Map();
  for (const variant of VARIANTS) {
    const markdownName = expectedFileName(archiveWeek, variant, "md", temporary);
    const markdownPath = path.join(resolvedDirectory, markdownName);
    if (fs.existsSync(markdownPath)) markdownByVariant.set(variant.key, { variant, markdownPath });
  }

  if (!temporary && markdownByVariant.size !== VARIANTS.length) {
    for (const variant of VARIANTS) {
      if (!markdownByVariant.has(variant.key)) errors.push(`正式纪要缺少 ${expectedFileName(archiveWeek, variant, "md", false)}`);
    }
  }
  if (temporary && markdownByVariant.size > 0 && markdownByVariant.size !== VARIANTS.length) {
    errors.push("临时纪要三版草案必须同时具备，或暂未生成三版草案");
  }

  const sharedMetadata = [];
  const documents = new Map();
  for (const { variant, markdownPath } of markdownByVariant.values()) {
    const content = fs.readFileSync(markdownPath, "utf8");
    const metadata = parseMetadata(content);
    validateMetadata(metadata, archiveWeek, root, path.basename(markdownPath), effectiveMode, errors, warnings);
    if (metadata) {
      sharedMetadata.push({ name: path.basename(markdownPath), metadata });
      validateDisplayHeader(content, metadata, archiveWeek, path.basename(markdownPath), errors);
      validateSignoff(content, metadata, path.basename(markdownPath), effectiveMode, errors);
      validateCountdownLine(content, path.basename(markdownPath), errors);
      validateHeadingNoDateRange(content, path.basename(markdownPath), errors);
      validateRequiredStructure(content, variant, metadata, errors);
      documents.set(variant.key, { content, variant });
    }
    if (!temporary) checkDocxPair(resolvedDirectory, markdownPath, expectedFileName(archiveWeek, variant, "docx", false), errors);
  }

  if (temporary && markdownByVariant.size === VARIANTS.length) {
    const hasAnyDocx = VARIANTS.some((variant) => fs.existsSync(path.join(resolvedDirectory, expectedFileName(archiveWeek, variant, "docx", true))));
    if (hasAnyDocx) {
      for (const { variant, markdownPath } of markdownByVariant.values()) {
        checkDocxPair(resolvedDirectory, markdownPath, expectedFileName(archiveWeek, variant, "docx", true), errors);
      }
    }
    const candidateName = `${archiveWeek}-董事长例会-待确认事项【待确认】.md`;
    const candidatePath = path.join(resolvedDirectory, candidateName);
    if (!fs.existsSync(candidatePath)) {
      errors.push(`临时纪要缺少 ${candidateName}`);
    } else {
      const candidateMetadata = parseMetadata(fs.readFileSync(candidatePath, "utf8"));
      validateMetadata(candidateMetadata, archiveWeek, root, candidateName, effectiveMode, errors, warnings);
      if (candidateMetadata) sharedMetadata.push({ name: candidateName, metadata: candidateMetadata });
    }
  }

  if (temporary) {
    const transcriptName = `${archiveWeek}-董事长例会-转录草稿【待编辑】.md`;
    const transcriptPath = path.join(resolvedDirectory, transcriptName);
    if (!fs.existsSync(transcriptPath)) {
      warnings.push(`未找到标准转录草稿：${transcriptName}`);
    } else {
      const transcriptMetadata = parseMetadata(fs.readFileSync(transcriptPath, "utf8"));
      validateMetadata(transcriptMetadata, archiveWeek, root, transcriptName, effectiveMode, errors, warnings);
      if (transcriptMetadata) sharedMetadata.push({ name: transcriptName, metadata: transcriptMetadata });
    }
  } else {
    for (const entry of entries) {
      if (entry.name.includes("【待")) errors.push(`正式会议纪要目录不得包含状态标记文件：${entry.name}`);
    }
  }

  if (sharedMetadata.length > 1) {
    const baseline = sharedMetadata[0].metadata;
    for (const { name, metadata } of sharedMetadata.slice(1)) {
      for (const key of META_KEYS) {
        if (metadata[key] !== baseline[key]) errors.push(`${name} 的 ${key} 与 ${sharedMetadata[0].name} 不一致`);
      }
    }
  }
  validateNodeViews(documents, errors);
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function main() {
  const argumentsList = process.argv.slice(2);
  const directory = argumentsList.find((argument) => !argument.startsWith("--"));
  const modeArgument = argumentsList.find((argument) => argument.startsWith("--mode="));
  const mode = modeArgument ? modeArgument.slice("--mode=".length) : undefined;
  if (!directory || argumentsList.includes("--help")) {
    console.log("用法: node scripts/check_meeting_minutes.js <会议目录> [--mode=temporary|formal]");
    process.exit(directory ? 0 : 1);
  }
  const result = validateMeetingDirectory({ directory, mode });
  for (const warning of result.warnings) console.log(`WARNING: ${warning}`);
  if (result.errors.length > 0) {
    console.log(`MEETING_MINUTES_CHECK_FAILED: ${result.errors.length}`);
    for (const error of result.errors) console.log(`ERROR: ${error}`);
    process.exit(1);
  }
  console.log(`MEETING_MINUTES_CHECK_OK: ${result.warnings.length === 0 ? "完整" : "通过，存在待确认字段"}`);
}

if (require.main === module) main();

module.exports = { parseMetadata, validateMeetingDirectory };