---
description: 'Use when creating or editing chairman weekly meeting minutes under 03-例会汇报/董事长例会/会议纪要. Keeps three versions factually aligned and routes execution items to the work ledger.'
applyTo: '03-例会汇报/董事长例会/会议纪要/**/*.md'
---

# 会议纪要约束

- 新建会议纪要必须使用会议实际日期所在周的 `YYYYMMDD-YYYYMMDD` 归档周期；不得使用无分隔日期短串。会议实际日期、汇报统计期、计划执行期、汇总截止日、草稿创建日期和实际签发日期必须在 `MEETING-MINUTES-META` 中分别维护，未知值写 `pending`；正式纪要的 `signed_at` 必须为已确认签发日，文末落款不得默认复用会议日期。
- 草稿只能在 `00-临时存放/会议纪要/<归档周期>/` 中生成并带状态标记；正式目录只保留经确认的三版 md/docx，不得包含转录草稿或待确认事项清单。
- 董事长版是事实和结构主源：重点工作时间节点为三列表，跟踪事项为四列表；总经理版保留同源三列表节点，完整版保留同源两列表节点。三版的同一时间节点、决策和指示不得相互矛盾。
- 只整理人工转录与汇报中的事实，不能补造会议决定、责任人、期限或处罚结论。
- 新的可执行事项必须标注责任/期限，或明确“待明确”；经用户确认后再登记到 `04-进度督察/工作台账/工作事项总台账.md`。
- 用户手改 Office 终稿时，以终稿为准回写 md，并同步三版对应内容。
- 生成或入库前必须检查同名 Word、`~$` 锁文件和 `scripts/check_meeting_minutes.js` 结果；不得以 `--force` 覆盖已手改的 Word 终稿。
- Word 排版固定遵循历史 `20260824830` 群发版的 `20260824830-group-v1` 合同：无独立页眉、页脚或页码，正文末尾右对齐签发和日期；表头底纹固定为 `D9E2F3`，不得改为灰色。三版 Markdown 和 Word 副标题均固定两行：公司/标准周序号/周一至周日，及“主持人：总经办 ｜ 出席：各专业负责人 ｜ 记录/整理：总经办 ｜ 签发：总经办”。倒计时汇总行必须整体加粗（`**倒计时：…**`），不得仅加粗标签。改动 `scripts/generate_docx_from_md.js` 前必须同步 `scripts/test_meeting_minutes.js` 的 DOCX 版式断言及会议纪要 README。
