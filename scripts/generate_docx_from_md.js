const fs = require("fs");
const path = require("path");
const {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} = require("docx");

const MEETING_MINUTES_WORD_LAYOUT = Object.freeze({
  id: "20260824830-group-v1",
  pageMargin: { top: 1200, bottom: 1200, left: 1400, right: 1400 },
  title: { font: "黑体", size: 36, after: 60 },
  subtitle: { font: "微软雅黑", size: 20, after: 200 },
  details: { font: "仿宋", size: 24, before: 40, after: 40, line: 320 },
  heading: { font: "黑体", size: 28, before: 200, after: 100 },
  body: { font: "仿宋", size: 24, after: 60, line: 320 },
  table: { font: "仿宋", size: 20, border: "999999", headerFill: "D9E2F3" },
  signoff: { font: "微软雅黑", size: 24, before: 300 },
});

const argumentsList = process.argv.slice(2);
const force = argumentsList.includes("--force");
const paths = argumentsList.filter((argument) => argument !== "--force");

if (paths.length !== 2) {
  throw new Error(
    "Usage: node scripts/generate_docx_from_md.js <source.md> <output.docx> [--force]",
  );
}

const sourcePath = path.resolve(paths[0]);
const outputPath = path.resolve(paths[1]);

if (!sourcePath.toLowerCase().endsWith(".md") || !fs.existsSync(sourcePath)) {
  throw new Error(`Markdown source not found: ${sourcePath}`);
}
if (!outputPath.toLowerCase().endsWith(".docx")) {
  throw new Error(`Output must be a .docx file: ${outputPath}`);
}
if (fs.existsSync(outputPath) && !force) {
  throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
}

const source = fs.readFileSync(sourcePath, "utf8");
const solidBorder = { style: BorderStyle.SINGLE, size: 4, color: "666666" };
const paragraphSpacing = { after: 100, line: 360 };

function plainText(value) {
  return value.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\s+/g, " ").trim();
}

function findMeetingMinutesHeader(lines) {
  const titleIndex = lines.findIndex((line) => /^#\s+.*董事长周例会会议纪要/.test(line.trim()));
  if (titleIndex === -1) return null;

  const quoteLines = [];
  let nextIndex = titleIndex + 1;
  while (nextIndex < lines.length) {
    const trimmed = lines[nextIndex].trim();
    if (!trimmed || trimmed === "---") {
      nextIndex += 1;
      continue;
    }
    if (/^>\s+/.test(trimmed)) {
      quoteLines.push(trimmed.replace(/^>\s+/, ""));
      nextIndex += 1;
      continue;
    }
    break;
  }

  const subtitleSource = plainText(quoteLines[0] ?? "");
  const details = "主持人：总经办 ｜ 出席：各专业负责人 ｜ 记录/整理：总经办 ｜ 签发：总经办";

  return {
    titleIndex,
    nextIndex,
    subtitle: subtitleSource.includes("江西柯美纸业有限公司")
      ? subtitleSource
      : ["江西柯美纸业有限公司", subtitleSource].filter(Boolean).join(" ｜ "),
    details,
  };
}

function inlineRuns(value, options = {}) {
  const runs = [];
  const expression = /\*\*(.+?)\*\*/g;
  let currentIndex = 0;
  let match;

  while ((match = expression.exec(value)) !== null) {
    if (match.index > currentIndex) {
      runs.push(new TextRun({ text: value.slice(currentIndex, match.index), ...options }));
    }
    runs.push(new TextRun({ text: match[1], bold: true, ...options }));
    currentIndex = expression.lastIndex;
  }

  if (currentIndex < value.length || runs.length === 0) {
    runs.push(new TextRun({ text: value.slice(currentIndex), ...options }));
  }
  return runs;
}

function createParagraph(text, options = {}) {
  return new Paragraph({
    children: inlineRuns(text, { font: "宋体", size: 21, ...options.run }),
    alignment: options.alignment ?? AlignmentType.JUSTIFIED,
    spacing: options.spacing ?? paragraphSpacing,
    indent: options.indent,
  });
}

function meetingBodyOptions(options = {}) {
  return {
    ...options,
    spacing:
      options.spacing ?? {
        after: MEETING_MINUTES_WORD_LAYOUT.body.after,
        line: MEETING_MINUTES_WORD_LAYOUT.body.line,
      },
    run: {
      font: MEETING_MINUTES_WORD_LAYOUT.body.font,
      size: MEETING_MINUTES_WORD_LAYOUT.body.size,
      ...options.run,
    },
  };
}

function createMeetingTitle() {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: MEETING_MINUTES_WORD_LAYOUT.title.after },
    children: [
      new TextRun({
        text: "董事长周例会会议纪要",
        font: MEETING_MINUTES_WORD_LAYOUT.title.font,
        size: MEETING_MINUTES_WORD_LAYOUT.title.size,
        bold: true,
      }),
    ],
  });
}

function createMeetingHeaderParagraph(text, style) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: {
      before: style.before,
      after: style.after,
      line: style.line,
    },
    children: [new TextRun({ text, font: style.font, size: style.size })],
  });
}

function createMeetingSignoff(text, isLabel) {
  return new Paragraph({
    alignment: AlignmentType.RIGHT,
    spacing: isLabel ? { before: MEETING_MINUTES_WORD_LAYOUT.signoff.before } : undefined,
    children: [
      new TextRun({
        text,
        font: MEETING_MINUTES_WORD_LAYOUT.signoff.font,
        size: MEETING_MINUTES_WORD_LAYOUT.signoff.size,
        bold: isLabel,
      }),
    ],
  });
}

function createHeading(text, level, isMeetingMinutes = false) {
  if (isMeetingMinutes) {
    return new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: {
        before: level === 2 ? MEETING_MINUTES_WORD_LAYOUT.heading.before : 160,
        after: level === 2 ? MEETING_MINUTES_WORD_LAYOUT.heading.after : 80,
      },
      keepNext: true,
      children: [
        new TextRun({
          text,
          font: MEETING_MINUTES_WORD_LAYOUT.heading.font,
          size: level === 2 ? MEETING_MINUTES_WORD_LAYOUT.heading.size : 26,
          bold: true,
        }),
      ],
    });
  }

  const heading = {
    1: { size: 40, alignment: AlignmentType.CENTER, before: 0, after: 360 },
    2: { size: 32, alignment: AlignmentType.LEFT, before: 360, after: 180 },
    3: { size: 28, alignment: AlignmentType.LEFT, before: 240, after: 120 },
  }[level];

  return new Paragraph({
    heading: level === 1 ? HeadingLevel.TITLE : level === 2 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
    alignment: heading.alignment,
    spacing: { before: heading.before, after: heading.after, line: 360 },
    keepNext: true,
    children: [new TextRun({ text, font: "黑体", size: heading.size, bold: true })],
  });
}

function createTable(rows, isMeetingMinutes = false) {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const border = isMeetingMinutes
    ? { style: BorderStyle.SINGLE, size: 4, color: MEETING_MINUTES_WORD_LAYOUT.table.border }
    : solidBorder;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: "autofit",
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
    rows: rows.map(
      (row, rowIndex) =>
        new TableRow({
          tableHeader: rowIndex === 0,
          cantSplit: true,
          children: Array.from({ length: columnCount }, (_, columnIndex) => {
            const cellText = row[columnIndex] ?? "";
            return new TableCell({
              verticalAlign: VerticalAlign.CENTER,
              shading:
                rowIndex === 0
                  ? {
                      type: ShadingType.CLEAR,
                      color: "auto",
                      fill: isMeetingMinutes ? MEETING_MINUTES_WORD_LAYOUT.table.headerFill : "E6E6E6",
                    }
                  : undefined,
              margins: isMeetingMinutes ? { top: 0, bottom: 0, left: 10, right: 10 } : { top: 80, bottom: 80, left: 80, right: 80 },
              children: [
                new Paragraph({
                  children: inlineRuns(cellText, {
                    font: isMeetingMinutes ? MEETING_MINUTES_WORD_LAYOUT.table.font : "宋体",
                    size: isMeetingMinutes ? MEETING_MINUTES_WORD_LAYOUT.table.size : 17,
                    bold: isMeetingMinutes && rowIndex === 0,
                  }),
                  spacing: { after: 0, line: isMeetingMinutes ? 260 : 280 },
                  alignment:
                    isMeetingMinutes && (rowIndex === 0 || columnIndex === 0)
                      ? AlignmentType.CENTER
                      : AlignmentType.LEFT,
                }),
              ],
            });
          }),
        }),
    ),
  });
}

const children = [];
const lines = source.split(/\r?\n/);
const meetingMinutesHeader = findMeetingMinutesHeader(lines);
const isMeetingMinutes = meetingMinutesHeader !== null;
let lineIndex = 0;

while (lineIndex < lines.length) {
  const trimmed = lines[lineIndex].trim();

  if (isMeetingMinutes && lineIndex === meetingMinutesHeader.titleIndex) {
    children.push(createMeetingTitle());
    if (meetingMinutesHeader.subtitle) {
      children.push(createMeetingHeaderParagraph(meetingMinutesHeader.subtitle, MEETING_MINUTES_WORD_LAYOUT.subtitle));
    }
    if (meetingMinutesHeader.details) {
      children.push(createMeetingHeaderParagraph(meetingMinutesHeader.details, MEETING_MINUTES_WORD_LAYOUT.details));
    }
    lineIndex = meetingMinutesHeader.nextIndex;
    continue;
  }

  if (!trimmed) {
    lineIndex += 1;
    continue;
  }

  if (/^<!--\s*MEETING-MINUTES-META(?::|\s|$)/.test(trimmed)) {
    while (lineIndex < lines.length && !/-->\s*$/.test(lines[lineIndex])) {
      lineIndex += 1;
    }
    lineIndex += 1;
    continue;
  }

  if (/^\|.*\|$/.test(trimmed)) {
    const rows = [];
    while (lineIndex < lines.length && /^\|.*\|$/.test(lines[lineIndex].trim())) {
      const tableLine = lines[lineIndex].trim();
      if (!/^\|[\s:|-]+\|$/.test(tableLine)) {
        rows.push(tableLine.slice(1, -1).split("|").map((cell) => cell.trim()));
      }
      lineIndex += 1;
    }
    children.push(createTable(rows, isMeetingMinutes));
    if (!isMeetingMinutes) children.push(new Paragraph({ spacing: { after: 100 } }));
    continue;
  }

  if (trimmed === ">") {
    lineIndex += 1;
    continue;
  }
  if (trimmed === "---") {
    if (!isMeetingMinutes) children.push(new Paragraph({ spacing: { before: 80, after: 80 } }));
  } else if (/^#\s+/.test(trimmed)) {
    children.push(createHeading(trimmed.replace(/^#\s+/, ""), 1, isMeetingMinutes));
  } else if (/^##\s+/.test(trimmed)) {
    children.push(createHeading(trimmed.replace(/^##\s+/, ""), 2, isMeetingMinutes));
  } else if (/^###\s+/.test(trimmed)) {
    children.push(createHeading(trimmed.replace(/^###\s+/, ""), 3, isMeetingMinutes));
  } else if (isMeetingMinutes && /^\*\*签发[：:]/.test(trimmed)) {
    children.push(createMeetingSignoff(plainText(trimmed), true));
  } else if (isMeetingMinutes && /^\*\*\d{4}\s*年/.test(trimmed)) {
    children.push(createMeetingSignoff(plainText(trimmed), false));
  } else if (/^>\s+/.test(trimmed)) {
    const quoteOptions = isMeetingMinutes
      ? meetingBodyOptions({
          indent: undefined,
          spacing: { after: 60, line: MEETING_MINUTES_WORD_LAYOUT.body.line },
        })
      : {
        indent: { left: 420 },
        spacing: { after: 60, line: 300 },
        run: { size: 19, italics: true, color: "444444" },
      };
    children.push(createParagraph(trimmed.replace(/^>\s+/, ""), quoteOptions));
  } else if (/^-\s+/.test(trimmed)) {
    const text = `- ${trimmed.replace(/^-\s+/, "")}`;
    children.push(createParagraph(text, isMeetingMinutes ? meetingBodyOptions({ indent: { left: 420 } }) : { indent: { left: 420 } }));
  } else if (/^\d+\.\s+/.test(trimmed)) {
    const text = isMeetingMinutes ? `• ${trimmed.replace(/^\d+\.\s+/, "")}` : trimmed;
    const options = { indent: { left: 420, hanging: 210 } };
    children.push(createParagraph(text, isMeetingMinutes ? meetingBodyOptions(options) : options));
  } else {
    children.push(createParagraph(trimmed, isMeetingMinutes ? meetingBodyOptions() : {}));
  }
  lineIndex += 1;
}

const document = new Document({
  sections: [
    {
      properties: {
        page: {
          margin: isMeetingMinutes
            ? MEETING_MINUTES_WORD_LAYOUT.pageMargin
            : { top: 1440, bottom: 1440, left: 1800, right: 1800 },
        },
      },
      children,
    },
  ],
});

Packer.toBuffer(document).then((buffer) => {
  fs.writeFileSync(outputPath, buffer);
  const sourceModifiedAt = fs.statSync(sourcePath).mtimeMs;
  const outputModifiedAt = new Date(Math.max(Date.now(), sourceModifiedAt + 1000));
  fs.utimesSync(outputPath, outputModifiedAt, outputModifiedAt);
  console.log(`DOCX_CREATED: ${outputPath}`);
  console.log(`BYTES: ${fs.statSync(outputPath).size}`);
});