const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const zlib = require("node:zlib");
const { createPackage, deriveArchiveWeek } = require("./create_meeting_package");
const { validateMeetingDirectory } = require("./check_meeting_minutes");

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kemei-meeting-test-"));
}

function removeTempRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function readZipEntry(zipPath, expectedName) {
  const archive = fs.readFileSync(zipPath);
  for (let offset = 0; offset <= archive.length - 46; offset += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) continue;
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const fileNameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const fileName = archive.toString("utf8", offset + 46, offset + 46 + fileNameLength);
    if (fileName === expectedName) {
      assert.equal(archive.readUInt32LE(localHeaderOffset), 0x04034b50, `${expectedName} 本地文件头无效`);
      const localFileNameLength = archive.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
      const contentStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
      const compressed = archive.subarray(contentStart, contentStart + compressedSize);
      return compressionMethod === 0 ? compressed : zlib.inflateRawSync(compressed);
    }
    offset += 46 + fileNameLength + extraLength + commentLength - 1;
  }
  return null;
}

function metadata(week) {
  return `<!-- MEETING-MINUTES-META
meeting_date: 2026-08-31
archive_week: ${week}
report_period: pending
plan_period: pending
report_cutoff: pending
summary_source: pending
roster_source: pending
audio_source: pending
transcript_source: pending
signed_at: 2026-09-02
-->`;
}

function displayHeader(week) {
  const start = `${week.slice(0, 4)}-${week.slice(4, 6)}-${week.slice(6, 8)}`;
  const end = `${week.slice(13, 15)}-${week.slice(15, 17)}`;
  return `> 江西柯美纸业有限公司 ｜ 周序号 ${week} ｜ ${start} ～ ${end}
> 主持人：总经办 ｜ 出席：各专业负责人 ｜ 记录/整理：总经办 ｜ 签发：总经办`;
}

function variantContent(week, variant) {
  const common = metadata(week);
  if (variant === "董事长版") {
    return `${common}
# 董事长版

${displayHeader(week)}

## 一、会议信息

| 项目 | 内容 |
| --- | --- |
| 会议时间 | 2026 年 8 月 31 日 |

## 二、重点工作时间节点

| 节点日期 | 事项 | 责任部门 |
| --- | --- | --- |
| 9.1 | 事项甲 | 项目部 |
| 待明确 | 事项乙 | 待明确 |

## 三、本周重点工作

1. 事项甲。

## 四、董事长指示与要求

1. 指示甲。

## 五、总经理要求

1. 要求甲。

## 六、跟踪事项

| 序号 | 事项 | 时间节点 | 责任 |
| --- | --- | --- |
| 1 | 事项甲 | 9.1 | 项目部 |

---

**签发：江西柯美纸业有限公司 总经办**
**2026 年 9 月 2 日**
`;
  }
  if (variant === "总经理版") {
    return `${common}
# 总经理版

  ${displayHeader(week)}

## 一、关键时间节点

| 时间 | 事项 | 责任 |
| --- | --- | --- |
| 9.1 | 事项甲 | 项目部 |
| 待明确 | 事项乙 | 待明确 |

## 二、重点工作安排

1. 事项甲。

## 三、董事长指示要点

1. 指示甲。

## 四、总经理要求

1. 要求甲。

---

**签发：江西柯美纸业有限公司 总经办 ｜ 2026 年 9 月 2 日**
`;
  }
  return `${common}
# 群发版

${displayHeader(week)}

## 一、董事长讲话核心

1. 指示甲。

## 二、总经理讲话核心

1. 要求甲。

## 三、重点工作时间节点

| 时间 | 事项 |
| --- | --- |
| 9.1 | 事项甲 |
| 待明确 | 事项乙 |

## 四、本周重点工作

1. 事项甲。

---

**签发：江西柯美纸业有限公司 总经办**
**2026 年 9 月 2 日**
`;
}

test("会议日期推导会议日所在周，覆盖跨月", () => {
  assert.equal(deriveArchiveWeek("2026-08-31"), "20260831-20260906");
  assert.equal(deriveArchiveWeek("2026-09-06"), "20260831-20260906");
  assert.throws(() => deriveArchiveWeek("2026-02-30"));
});

test("创建器生成标准临时会议包且拒绝覆盖", () => {
  const root = createTempRoot();
  try {
    const result = createPackage({ root, meetingDate: "2026-08-31" });
    assert.match(result.transcriptPath, /20260831-20260906/);
    assert.ok(fs.existsSync(result.transcriptPath));
    assert.match(fs.readFileSync(result.transcriptPath, "utf8"), /signed_at: pending/);
    assert.throws(() => createPackage({ root, meetingDate: "2026-08-31" }));
    assert.deepEqual(validateMeetingDirectory({ root, directory: result.packageDirectory, mode: "temporary" }).errors, []);
  } finally {
    removeTempRoot(root);
  }
});

test("正式校验识别三版节点表、配套 Word 和元数据不一致", () => {
  const root = createTempRoot();
  try {
    const week = "20260831-20260906";
    const directory = path.join(root, "03-例会汇报", "董事长例会", "会议纪要", week);
    fs.mkdirSync(directory, { recursive: true });
    for (const variant of ["董事长版", "总经理版", "完整版（群发）"]) {
      const markdownName = `${week}-董事长例会纪要-${variant}.md`;
      fs.writeFileSync(path.join(directory, markdownName), variantContent(week, variant), "utf8");
      fs.writeFileSync(path.join(directory, `${week}-董事长例会纪要-${variant}.docx`), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    }
    assert.deepEqual(validateMeetingDirectory({ root, directory, mode: "formal" }).errors, []);
    const managerPath = path.join(directory, `${week}-董事长例会纪要-总经理版.md`);
    fs.writeFileSync(managerPath, fs.readFileSync(managerPath, "utf8").replace(`archive_week: ${week}`, "archive_week: 20260824-20260830"), "utf8");
    const result = validateMeetingDirectory({ root, directory, mode: "formal" });
    assert.ok(result.errors.some((error) => error.includes("archive_week")));
    fs.writeFileSync(managerPath, fs.readFileSync(managerPath, "utf8").replace("archive_week: 20260824-20260830", `archive_week: ${week}`), "utf8");
    fs.writeFileSync(managerPath, fs.readFileSync(managerPath, "utf8").replace("主持人：总经办", "主持人：项目部"), "utf8");
    const headerResult = validateMeetingDirectory({ root, directory, mode: "formal" });
    assert.ok(headerResult.errors.some((error) => error.includes("副标题第二行")));
    fs.writeFileSync(managerPath, fs.readFileSync(managerPath, "utf8").replace("主持人：项目部", "主持人：总经办"), "utf8");
    fs.writeFileSync(managerPath, fs.readFileSync(managerPath, "utf8").replace("signed_at: 2026-09-02", "signed_at: pending"), "utf8");
    const pendingSignoffResult = validateMeetingDirectory({ root, directory, mode: "formal" });
    assert.ok(pendingSignoffResult.errors.some((error) => error.includes("signed_at")));
    fs.writeFileSync(managerPath, fs.readFileSync(managerPath, "utf8").replace("signed_at: pending", "signed_at: 2026-09-02"), "utf8");
    fs.writeFileSync(managerPath, fs.readFileSync(managerPath, "utf8").replace("2026 年 9 月 2 日", "2026 年 9 月 3 日"), "utf8");
    const signoffResult = validateMeetingDirectory({ root, directory, mode: "formal" });
    assert.ok(signoffResult.errors.some((error) => error.includes("文末签发日期")));
    fs.writeFileSync(managerPath, fs.readFileSync(managerPath, "utf8").replace("2026 年 9 月 3 日", "2026 年 9 月 2 日"), "utf8");
    const groupPath = path.join(directory, `${week}-董事长例会纪要-完整版（群发）.md`);
    fs.writeFileSync(groupPath, fs.readFileSync(groupPath, "utf8").replace("| 9.1 | 事项甲 |", "| 9.2 | 事项甲 |"), "utf8");
    const nodeResult = validateMeetingDirectory({ root, directory, mode: "formal" });
    assert.ok(nodeResult.errors.some((error) => error.includes("群发版第 1 条节点日期/时限")));
  } finally {
    removeTempRoot(root);
  }
});

test("正式校验强制倒计时行整体加粗", () => {
  const root = createTempRoot();
  try {
    const week = "20260831-20260906";
    const directory = path.join(root, "03-例会汇报", "董事长例会", "会议纪要", week);
    fs.mkdirSync(directory, { recursive: true });
    for (const variant of ["董事长版", "总经理版", "完整版（群发）"]) {
      const markdownName = `${week}-董事长例会纪要-${variant}.md`;
      fs.writeFileSync(path.join(directory, markdownName), variantContent(week, variant), "utf8");
      fs.writeFileSync(path.join(directory, `${week}-董事长例会纪要-${variant}.docx`), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    }
    const groupPath = path.join(directory, `${week}-董事长例会纪要-完整版（群发）.md`);
    const baseContent = fs.readFileSync(groupPath, "utf8");
    fs.writeFileSync(groupPath, `${baseContent}\n> **倒计时**：水处理距离运行 32 天。\n`, "utf8");
    const partialResult = validateMeetingDirectory({ root, directory, mode: "formal" });
    assert.ok(partialResult.errors.some((error) => error.includes("倒计时行必须整体加粗")));
    fs.writeFileSync(groupPath, `${baseContent}\n> **倒计时：水处理距离运行 32 天。**\n`, "utf8");
    const fullResult = validateMeetingDirectory({ root, directory, mode: "formal" });
    assert.ok(!fullResult.errors.some((error) => error.includes("倒计时行必须整体加粗")));
  } finally {
    removeTempRoot(root);
  }
});

test("正式校验拒绝章节标题附加具体日期区间", () => {
  const root = createTempRoot();
  try {
    const week = "20260831-20260906";
    const directory = path.join(root, "03-例会汇报", "董事长例会", "会议纪要", week);
    fs.mkdirSync(directory, { recursive: true });
    for (const variant of ["董事长版", "总经理版", "完整版（群发）"]) {
      const markdownName = `${week}-董事长例会纪要-${variant}.md`;
      fs.writeFileSync(path.join(directory, markdownName), variantContent(week, variant), "utf8");
      fs.writeFileSync(path.join(directory, `${week}-董事长例会纪要-${variant}.docx`), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    }
    const groupPath = path.join(directory, `${week}-董事长例会纪要-完整版（群发）.md`);
    fs.writeFileSync(groupPath, fs.readFileSync(groupPath, "utf8").replace("## 三、重点工作时间节点", "## 三、重点工作时间节点（9.1—9.7 重点工作计划）"), "utf8");
    const result = validateMeetingDirectory({ root, directory, mode: "formal" });
    assert.ok(result.errors.some((error) => error.includes("章节标题不得附加具体日期区间")));
  } finally {
    removeTempRoot(root);
  }
});

test("会议纪要 Word 固化 20260824830 群发版版式", () => {
  const root = createTempRoot();
  try {
    const markdownPath = path.join(root, "会议纪要.md");
    const wordPath = path.join(root, "会议纪要.docx");
    fs.writeFileSync(
      markdownPath,
      `${metadata("20260831-20260906")}
# 江西柯美纸业有限公司 · 董事长周例会会议纪要（完整版）

> 江西柯美纸业有限公司 ｜ 周序号 20260831-20260906 ｜ 2026-08-31 ～ 09-06
> 主持人：待补充 ｜ 出席人员：待补充 ｜ 记录/整理：待补充 ｜ 签发：待补充

---

## 一、董事长讲话核心

1. **事项甲**：落实工作。

## 二、总经理讲话核心

1. **事项乙**：持续跟进。

## 三、重点工作时间节点

| 时间 | 事项 |
| --- | --- |
| 9.1 | 节点甲 |

## 四、本周重点工作

1. 事项甲。

---

**签发：江西柯美纸业有限公司 总经办**
**2026 年 9 月 2 日**
`,
      "utf8",
    );
    execFileSync(process.execPath, [path.join(__dirname, "generate_docx_from_md.js"), markdownPath, wordPath]);
    assert.ok(fs.statSync(wordPath).mtimeMs > fs.statSync(markdownPath).mtimeMs);
    const documentXml = readZipEntry(wordPath, "word/document.xml").toString("utf8");
    assert.equal(readZipEntry(wordPath, "word/footer1.xml"), null);
    assert.match(documentXml, /董事长周例会会议纪要/);
    assert.match(documentXml, /江西柯美纸业有限公司 ｜ 周序号 20260831-20260906 ｜ 2026-08-31 ～ 09-06/);
    assert.match(documentXml, /主持人：总经办 ｜ 出席：各专业负责人 ｜ 记录\/整理：总经办 ｜ 签发：总经办/);
    assert.doesNotMatch(documentXml, /主持人：待补充/);
    assert.doesNotMatch(documentXml, /出席人员[：:]/);
    assert.match(documentXml, /w:top="1200" w:right="1400" w:bottom="1200" w:left="1400"/);
    assert.match(documentXml, /w:eastAsia="黑体"/);
    assert.match(documentXml, /w:eastAsia="微软雅黑"/);
    assert.match(documentXml, /w:eastAsia="仿宋"/);
    assert.match(documentXml, /(?:•|&#x2022;)\s*事项甲/);
    assert.match(documentXml, /w:color="999999"/);
    assert.match(documentXml, /w:fill="D9E2F3"/);
    assert.match(documentXml, /<w:jc w:val="right"/);
  } finally {
    removeTempRoot(root);
  }
});