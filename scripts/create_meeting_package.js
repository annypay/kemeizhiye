#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PENDING = "pending";

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function deriveArchiveWeek(meetingDate) {
  const date = parseIsoDate(meetingDate);
  if (!date) throw new Error(`会议日期格式无效：${meetingDate}；应为 YYYY-MM-DD`);
  const daysFromMonday = (date.getUTCDay() + 6) % 7;
  const monday = addDays(date, -daysFromMonday);
  const sunday = addDays(monday, 6);
  return `${formatIsoDate(monday).replaceAll("-", "")}-${formatIsoDate(sunday).replaceAll("-", "")}`;
}

function parseArguments(argumentsList) {
  if (argumentsList.length === 0 || argumentsList.includes("--help")) {
    return { help: true };
  }

  const options = {
    reportPeriod: PENDING,
    planPeriod: PENDING,
    reportCutoff: PENDING,
    summarySource: PENDING,
    rosterSource: PENDING,
    audioSource: PENDING,
  };
  const optionNames = new Map([
    ["--report-period", "reportPeriod"],
    ["--plan-period", "planPeriod"],
    ["--report-cutoff", "reportCutoff"],
    ["--summary-source", "summarySource"],
    ["--roster-source", "rosterSource"],
    ["--audio-source", "audioSource"],
  ]);
  const meetingDate = argumentsList[0];

  for (let index = 1; index < argumentsList.length; index += 2) {
    const optionName = argumentsList[index];
    const optionValue = argumentsList[index + 1];
    const property = optionNames.get(optionName);
    if (!property || !optionValue) {
      throw new Error(`未知或缺少值的参数：${optionName ?? ""}`);
    }
    options[property] = optionValue;
  }

  return { meetingDate, options };
}

function assertOptionalDate(value, label) {
  if (value !== PENDING && !parseIsoDate(value)) {
    throw new Error(`${label} 格式无效：${value}；应为 YYYY-MM-DD 或 pending`);
  }
}

function assertOptionalReportPeriod(value) {
  if (value === PENDING) return;
  const [start, end, ...rest] = value.split("/");
  if (rest.length > 0 || !parseIsoDate(start) || !parseIsoDate(end) || start > end) {
    throw new Error(`汇报统计期格式无效：${value}；应为 YYYY-MM-DD/YYYY-MM-DD 或 pending`);
  }
}

function toRepositoryPath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function createPackage({ root = ROOT, meetingDate, options = {} }) {
  const archiveWeek = deriveArchiveWeek(meetingDate);
  const values = {
    reportPeriod: options.reportPeriod ?? PENDING,
    planPeriod: options.planPeriod ?? PENDING,
    reportCutoff: options.reportCutoff ?? PENDING,
    summarySource: options.summarySource ?? PENDING,
    rosterSource: options.rosterSource ?? PENDING,
    audioSource: options.audioSource ?? PENDING,
  };
  assertOptionalReportPeriod(values.reportPeriod);
  assertOptionalReportPeriod(values.planPeriod);
  assertOptionalDate(values.reportCutoff, "汇总截止日");

  const packageDirectory = path.join(root, "00-临时存放", "会议纪要", archiveWeek);
  if (fs.existsSync(packageDirectory)) {
    throw new Error(`会议临时包已存在，拒绝覆盖：${toRepositoryPath(root, packageDirectory)}`);
  }

  const transcriptName = `${archiveWeek}-董事长例会-转录草稿【待编辑】.md`;
  const transcriptPath = path.join(packageDirectory, transcriptName);
  const transcriptSource = toRepositoryPath(root, transcriptPath);
  const createdAt = formatIsoDate(new Date());
  const content = `<!-- MEETING-MINUTES-META
meeting_date: ${meetingDate}
archive_week: ${archiveWeek}
report_period: ${values.reportPeriod}
plan_period: ${values.planPeriod}
report_cutoff: ${values.reportCutoff}
summary_source: ${values.summarySource}
roster_source: ${values.rosterSource}
audio_source: ${values.audioSource}
transcript_source: ${transcriptSource}
draft_created_at: ${createdAt}
signed_at: ${PENDING}
-->
# 江西柯美纸业有限公司 · 董事长例会转录草稿

> **归档周期**：${archiveWeek} ｜ **会议日期**：${meetingDate}
> **汇报统计期**：${values.reportPeriod} ｜ **计划执行期**：${values.planPeriod} ｜ **汇总截止日**：${values.reportCutoff}

## 董事长发言

待录入：仅记录会议原话和明确结论。

## 总经理发言

待录入：仅记录会议原话和明确结论。

## 其他会议决策与重点节点

待录入：标注来源材料中的日期、事项和责任部门；不能确认的信息写“待明确”。
`;

  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(transcriptPath, content, "utf8");
  return { archiveWeek, packageDirectory, transcriptPath };
}

function printUsage() {
  console.log("用法: node scripts/create_meeting_package.js YYYY-MM-DD [选项]");
  console.log("选项: --report-period YYYY-MM-DD/YYYY-MM-DD --plan-period YYYY-MM-DD/YYYY-MM-DD --report-cutoff YYYY-MM-DD");
  console.log("      --summary-source 路径 --roster-source 路径 --audio-source 路径");
}

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    printUsage();
    return;
  }
  const result = createPackage({ meetingDate: parsed.meetingDate, options: parsed.options });
  console.log(`MEETING_PACKAGE_CREATED: ${toRepositoryPath(ROOT, result.packageDirectory)}`);
  console.log(`TRANSCRIPT_TEMPLATE: ${toRepositoryPath(ROOT, result.transcriptPath)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { createPackage, deriveArchiveWeek, parseIsoDate };