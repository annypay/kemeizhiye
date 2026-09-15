# scripts/ — 文档库运维脚本

本目录是总经办文档库的**全部工具脚本**（Node.js + PowerShell）。脚本只做「读取源文件 → 生成产出」，**没有任何脚本会改名或移动原始资料**。

> **PowerShell 脚本（`*.ps1`）必须保存为 UTF-8 带 BOM。**
> 本机是 Windows PowerShell 5.1 + ANSI 代码页 936，无 BOM 时 PowerShell 按 GBK 解码，脚本内的中文会全部乱码、路径失效。用编辑器另存时选「UTF-8 with BOM」，不要选「UTF-8」。

## 一、脚本清单

### 1. 文档治理与索引

| 脚本 | 用途 | 用法 |
| --- | --- | --- |
| [`check_repo.js`](check_repo.js) | 仓库卫生检查：下载重复后缀、Office 临时文件、bak、大文件、根目录散文件、日期目录格式 | `node scripts/check_repo.js [--staged]` |
| [`gen_index.js`](gen_index.js) | 重建 `INDEX.md` 全文索引（**该文件只能由本脚本生成**） | `node scripts/gen_index.js` |
| [`check_work_ledger.js`](check_work_ledger.js) | 校验 `04-进度督察/工作台账/工作事项总台账.md` 的结构与编号 | `node scripts/check_work_ledger.js` |
| [`sync_chat.js`](sync_chat.js) | Copilot 会话记录双向同步（换电脑接续） | `--status` / `--export [--full]` / `--import [--full]` |

### 2. 会议纪要工具链

| 脚本 | 用途 | 用法 |
| --- | --- | --- |
| [`create_meeting_package.js`](create_meeting_package.js) | 按会议日期生成标准临时会议包（拒绝覆盖既有目录） | `node scripts/create_meeting_package.js <会议日期>` |
| [`check_meeting_minutes.js`](check_meeting_minutes.js) | 会议纪要严格校验：三版节点表、配套 Word、元数据一致性。历史会议包（目录名非 `YYYYMMDD-YYYYMMDD`）自动豁免并提示 WARNING | `--mode=temporary`（临时包）/ `--mode=formal`（正式区） |
| [`test_meeting_minutes.js`](test_meeting_minutes.js) | 上述工具的自动化测试（6 项） | 见第四节 |

流程与三版字段定义见 [会议纪要 README](../03-例会汇报/董事长例会/会议纪要/README.md)。

### 3. Markdown 转 Word

| 脚本 | 用途 | 用法 |
| --- | --- | --- |
| [`generate_docx_from_md.js`](generate_docx_from_md.js) | 由 Markdown 生成可编辑 DOCX（宋体正文、黑体标题、A4 页边距、页脚页码） | `node scripts/generate_docx_from_md.js <源.md> <目标.docx>` |

依赖 `docx@9.7.1`（见 [`package.json`](package.json)），首次使用需 `npm install --prefix scripts`。**默认拒绝覆盖已存在的 Word**：人工改过的 Word 优先，应先回写 Markdown；仅在用户明确确认 Markdown 为权威源且目标 Word 已关闭时才可加 `--force`。完整说明见根 README 8.5。

### 4. 现场照片标注（流程技能 `/photo-annotate`）

| 脚本 | 用途 | 用法 |
| --- | --- | --- |
| [`annotate_photos.ps1`](annotate_photos.ps1) | 为每张现场照片在左上角加红字文件名（白色描边），输出到源目录下的 `注释/`。字号按文件名长度自动适配；按 EXIF 5/6/7/8 自动摆正并移除方向标记；非 JPG（HEIC 等）显式列名报错 | `-SourceDir "<照片目录>" [-OutDirName 注释] [-DryRun]` |
| [`verify_photo_annotations.ps1`](verify_photo_annotations.ps1) | 逐张校验产出：数量、尺寸、红字位置与像素数；**可失败、带退出码** | `-SourceDir "<照片目录>"` |

流程说明见 [技能文档](../.github/skills/photo-annotate/SKILL.md)。原图只读，照片目录在仓库之外，本流程不向文档库写入文件。

### 5. 现场图集 PDF

| 脚本 | 用途 | 用法 |
| --- | --- | --- |
| [`generate_photo_album_pdf.js`](generate_photo_album_pdf.js) | **权威实现**：零第三方依赖、手写 PDF。按文件名顺序排成 A4 图集（封面 + 每页一图 + 照片索引表），图注为原文件名，JPEG 以 DCTDecode 原样嵌入（不重编码） | `--src "<照片目录>" --out "<输出.pdf>" [--title 图集名称] [--date YYYYMMDD]` |
| [`generate_photo_album_pdf.ps1`](generate_photo_album_pdf.ps1) | 备选实现：走 Word COM 自动化。输出效果与上者不同，仅在需要 Word 版式时使用 | `-SourceDir <照片目录> -OutputPdf <输出.pdf> [-Title ...] [-ShootDate ...]` |
| [`verify_photo_album_pdf.js`](verify_photo_album_pdf.js) | PDF 结构校验：文件头尾、xref 偏移、`/Pages /Count`、流解压、内嵌字体表一致性 | `node scripts/verify_photo_album_pdf.js <pdf>` |
| [`verify_album_content.js`](verify_album_content.js) | 内容核对：每页图注 == 源文件文件名（顺序、数量、文字全等），附录索引表覆盖齐全 | `node scripts/verify_album_content.js <pdf> <照片目录>` |
| [`verify_album_fonts.js`](verify_album_fonts.js) | 字体保真：内嵌 TrueType 子集与系统原字体逐字形轮廓、advance width 比对 | `node scripts/verify_album_fonts.js <pdf> <照片目录>` |
| [`verify_album_render.ps1`](verify_album_render.ps1) | GDI+ 实际渲染 PDF 内嵌字体子集，输出预览 PNG 供人工复核 | `-PdfPath <pdf> [-PhotoDir <照片目录>]` |

两张生成器读的都是**源目录顶层图片**（不含 `注释/` 等子目录），与第 4 节的标注流程互不依赖，可各自单独执行。

### 6. 测试

```powershell
npm test --prefix scripts      # 等价于在 scripts/ 下执行 node --test test_*.js
```

当前 6 项测试全部覆盖会议纪要工具链（会议日期推导、临时包创建、正式校验的三类拒绝条件、群发版版式固化）。

## 二、图集校验为什么是四个脚本

图集 PDF 是手写生成的，出错方式各不相同，因此按**互相独立**的维度分开校验，任何一个失败都能定位到具体层：

| 校验器 | 回答的问题 |
| --- | --- |
| `verify_photo_album_pdf.js` | 这个 PDF 结构合法吗？（解析器能不能打开） |
| `verify_album_content.js` | 内容对吗？（图注与文件名、索引表、页数） |
| `verify_album_fonts.js` | 字对了吗？（子集字形是否与原字体逐字节一致） |
| `verify_album_render.ps1` | 看起来对吗？（渲染成 PNG 人工复核） |

## 三、约定

1. 新增脚本在本文件登记：用途、用法、依赖、是否有测试；
2. 同一用途只保留**一个权威实现**；出现替代方案时在表中标明「权威／备选」，被替换的旧版本移入 `_archive/`（脚本亦已保存在 git 历史中）；
3. 脚本一律不修改、不改名、不移动业务文档；需要写文件时只写产出路径；
4. 破坏性操作（覆盖、删除）默认拒绝，需显式开关（如 `--force`）并在文档中写明人工确认边界。
