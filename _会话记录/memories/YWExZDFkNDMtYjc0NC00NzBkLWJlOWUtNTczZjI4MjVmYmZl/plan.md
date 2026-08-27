## Plan: 总经办闭环督办能力升级

围绕当前真实瓶颈建立“会议/计划/通报 → 事项台账 → 证据复查 → 归档发布”的闭环。实施重点不是增加更多孤立的文档模板，而是建立一份可追溯的事项主台账，并让周例会、会议纪要、督察通报和发布流程都以它为共同记录面。

**已确认的决策**
- 今后新建周例会目录统一使用 `YYYYMMDD-YYYYMMDD`，例如 `20260824-20260830`；历史目录与文件不改名。
- 在正式区建立工作事项主台账，先导入 2026-08-25 董事长版纪要的 8 项跟踪事项，状态均为“待确认”；不擅自补齐纪要未明确的责任人、日期或完成结论。
- 本轮完整实施：会议纪要、工作台账、督察通报三项能力，并强化既有文档入库、周例会和发布技能。
- 合同台账不纳入本轮：现有合同命名不规范且文件名不足以可靠识别金额与合同主体，先保留为后续专项治理，避免生成不可信数据。
- 不引入多智能体或 Hooks：当前核心问题是业务数据模型与验证缺失，不是并发能力；长会议材料出现上下文瓶颈后再评估 `.github/agents/`。

**发现与依据**
- 现有 [董事长版纪要](c:/Users/mrseven/Desktop/总经办文档/03-例会汇报/董事长例会/会议纪要/20260824830/2026824830-董事长例会纪要-董事长版.md) 已有 8 项“跟踪事项”，含责任和时间节点，但没有事项编号、状态、证据路径、复查日期与关闭标准，无法跨周闭环。
- [重大节点进度督察工作流程](c:/Users/mrseven/Desktop/总经办文档/04-进度督察/通报与处罚存档/重大节点进度督察工作流程.html) 已定义收计划、确认、通报、复查链条及三级追责，但其示例归档路径与当前 `04-进度督察/` 目录体系不一致，也没有机器可检索的 JK 编号台账。
- 已有 `weekly-meeting` 只清点“已交/缺报”，没有把会议决策和超期事项带入下一周；其文案把 `2026824830` 误称“8 位”，格式实际不固定且不能可靠解析。
- [README.md](c:/Users/mrseven/Desktop/总经办文档/README.md) 的 8.1 节仍写 `git add -A`，与 [repo-publish](c:/Users/mrseven/Desktop/总经办文档/.github/skills/repo-publish/SKILL.md) 的“逐个暂存、不得裹挟临时区”规则冲突。
- `check_repo.js` 只能报告全库历史告警，不能把本次暂存内容与遗留问题分开，发布时噪声较大。

**Phase 1 — 建立唯一事项主台账**
1. 新建 `04-进度督察/工作台账/`，并增加 `README.md`，定义“事实来源、事项台账、督察证据、通报文件”的关系与更新责任；台账是执行状态的唯一来源，不替代会议纪要、合同或原始计划。
2. 新建 `04-进度督察/工作台账/工作事项总台账.md`：以固定字段记录 `事项编号`、`状态`、`来源`、`事项`、`责任单位/人`、`截止日`、`最近更新`、`复查日`、`证据/归档`、`下一步`。状态仅允许 `待确认`、`进行中`、`待复查`、`已关闭`、`暂缓`、`已撤销`。
3. 从 2026-08-25 董事长版纪要第六节导入 8 项，编号从 `JK-RW-2026-0001` 连续至 `JK-RW-2026-0008`；来源精确链接该纪要，未明确字段保留“待明确”，状态全部为“待确认”。
4. 新建 `04-进度督察/工作台账/JK-通报编号流水.md`，作为 `JK-2026-xxxx` 的唯一编号来源；初始值只声明“首次签发前未分配编号”，禁止预占号。
5. 新增 `scripts/check_work_ledger.js`：解析台账数据区并校验事项编号唯一性、状态合法性、必填来源/事项/最近更新字段；对“已关闭”强制要求复查日期和证据路径，对“暂缓/已撤销”强制要求说明。它不对“待确认”事项凭空报错。

**Phase 2 — 建立三个业务技能**
6. 新建 `.github/skills/work-tracker/SKILL.md`（工作事项登记与闭环）：从会议纪要、周报、工作推进单、通报中提取事项；先去重并关联来源，再入台账；只在有证据和复查人时关闭事项；输出当期新增、超期、待确认、待复查清单。任何责任、日期或结论不明时标为待明确并向用户提问。
7. 新建 `.github/skills/meeting-minutes/SKILL.md`（董事长例会纪要）：输入为人工转录底稿、当期汇报、上期未关闭台账事项；输出三版六件纪要草案至 `00-临时存放/`，并生成待确认事项增量。规则包括：不编造会议决策、每项可执行决策必须有责任/期限或显式标记待明确、三版同源、一版被人工修改后回写 md 并同步其余版本。用户确认后交给 `doc-intake` 与 `work-tracker` 正式归档。
8. 新建 `.github/skills/jk-notice/SKILL.md`（督察通报）：先核查事项台账、计划来源、现场/回执证据与本月历史记录，再按通报/警告/罚款规则生成草案；所有通报先在 `00-临时存放/` 标记【待确认】，不得自动签发或处罚；确认签发后从流水表分配下一个 JK 编号，更新事项台账并归档证据路径。
9. 新建 `.github/prompts/work-status.prompt.md`（工作事项状态速查）：只读汇总台账，输出超期、7 日内到期、待确认、待复查项及责任人，不修改文件。

**Phase 3 — 强化已有技能与规则**
10. 更新 `.github/skills/weekly-meeting/SKILL.md`：
    - 新周目录使用 `YYYYMMDD-YYYYMMDD`；识别旧的日期目录与 `2026MDDMDD` 周序号，但不改名；
    - 汇报缺口清单之外，读取工作事项台账并输出“上周未关闭事项/本周到期事项/需例会决策事项”；
    - 会后调用 `meeting-minutes` 和 `work-tracker`，形成周例会闭环。
11. 更新 `.github/skills/doc-intake/SKILL.md`：入库前识别是否是决策、推进单、督察证据或通报；若会改变在办事项状态，要求同步台账，但不得由入库动作自动将事项标为已关闭。
12. 更新 `.github/skills/repo-publish/SKILL.md`：先运行 `node scripts/check_repo.js --staged`，再按需运行全库卫生检查；若台账被更改，强制运行 `node scripts/check_work_ledger.js`；明确检查结果需区分新违规与 28 项历史告警。
13. 更新 `scripts/check_repo.js` 支持 `--staged`：只检查暂存新增/修改路径的命名、Office 临时文件、备份、体积和目录规则；默认模式仍保留全库卫生扫描。暂存模式不输出既有锁文件和历史重复后缀，避免掩盖本次问题。
14. 新增 `.github/instructions/work-ledger.instructions.md`，仅匹配 `04-进度督察/工作台账/**/*.md`：禁止无证据关闭、禁止删除已有事项 ID、要求来源和变更时间。新增 `.github/instructions/meeting-minutes.instructions.md`，仅匹配会议纪要 md：要求三版同源、不可臆造、需把执行事项交给台账。
15. 更新根 `AGENTS.md`：增加事项台账的唯一性、关闭证据门槛、JK 编号分配规则及新周目录格式；保持简洁，把具体步骤留给 skills。

**Phase 4 — 同步人类文档与现有流程**
16. 更新根 `README.md`：
    - 纠正 8.1 节的 `git add -A` 为“逐个指定文件暂存”；
    - 5.2 节将未来周目录标准改为 `YYYYMMDD-YYYYMMDD`，标明历史格式保留；
    - 6.3 节扩展为“周例会 → 纪要 → 工作事项台账 → 下周复盘”；
    - 新增事项编号 `JK-RW-YYYY-NNNN`，并把 Phase 3 新技能及 `/work-status` 写入 8.5；
    - 将“通报编号流水登记表”从 TODO 移出，补充“事项主台账已建立”。
17. 更新 `03-例会汇报/董事长例会/会议纪要/README.md`：新产物目录与文件命名、三版六件后的“事项台账增量”、历史格式兼容规则与总经理版生成约束。
18. 更新 `04-进度督察/通报与处罚存档/重大节点进度督察工作流程.html`：将示例中的旧 `01_施工计划/` 等路径改为当前仓库的真实 `04-进度督察/节点汇总/`、`工作台账/`、`通报与处罚存档/` 路径，并把“编号流水、证据路径、事项复查”明确为闭环节点；不改动原始追责标准。

**实施依赖与并行性**
- 步骤 1–5 是所有技能的基础，先完成并通过 `check_work_ledger.js`。
- 步骤 6、7、8、9 可在台账数据格式冻结后并行编写；步骤 10–15 依赖台账路径和状态定义，随后实施。
- 步骤 16–18 依赖全部规范落定，可并行更新。
- 发布仅在上述变更全部验证后进行。

**验证**
1. 用 `node scripts/check_work_ledger.js` 验证初始 8 项台账；故意复制一个编号或将一项标为“已关闭”但不填证据，确认脚本拒绝，再恢复正确内容。
2. 暂存后运行 `node scripts/check_repo.js --staged`，确认只关注本轮内容；再运行默认模式，确认 28 项历史告警未被误判为本次问题。
3. 以 8 月 25 日纪要作为干跑输入，验证 `work-tracker` 能识别 8 条事项且不重复写入；以一条无证据事项验证其不能被关闭。
4. 验证 `jk-notice` 在缺少用户签发确认时只产生 `00-临时存放/` 草案，不新增 JK 正式编号。
5. 逐一检查每个 SKILL.md 的 `name` 与目录同名、frontmatter 有 keyword-rich description；检查两个 instructions 的 `applyTo` 匹配范围。
6. `node scripts/gen_index.js` 后确认 `.github` 新文件、工作台账和新脚本均收录到 `INDEX.md`。
7. `git diff --cached --check`、`git diff --cached --name-status` 通过；使用中文提交信息，以 `feat:` 前缀提交，`git push origin master` 后以 `git status -sb` 确认同步。

**Relevant files**
- `c:\Users\mrseven\Desktop\总经办文档\04-进度督察\工作台账\README.md` — 新建台账治理说明。
- `c:\Users\mrseven\Desktop\总经办文档\04-进度督察\工作台账\工作事项总台账.md` — 新建唯一执行状态记录，初始导入 8 项。
- `c:\Users\mrseven\Desktop\总经办文档\04-进度督察\工作台账\JK-通报编号流水.md` — 新建正式编号唯一来源。
- `c:\Users\mrseven\Desktop\总经办文档\scripts\check_work_ledger.js` — 新建台账结构与关闭证据校验。
- `c:\Users\mrseven\Desktop\总经办文档\scripts\check_repo.js` — 新增 staged-only 模式。
- `c:\Users\mrseven\Desktop\总经办文档\.github\skills\work-tracker\SKILL.md`、`meeting-minutes\SKILL.md`、`jk-notice\SKILL.md` — 新建高价值业务技能。
- `c:\Users\mrseven\Desktop\总经办文档\.github\skills\weekly-meeting\SKILL.md`、`doc-intake\SKILL.md`、`repo-publish\SKILL.md` — 补齐闭环引用与发布验证。
- `c:\Users\mrseven\Desktop\总经办文档\.github\prompts\work-status.prompt.md` — 新建只读状态速查。
- `c:\Users\mrseven\Desktop\总经办文档\.github\instructions\work-ledger.instructions.md`、`meeting-minutes.instructions.md` — 新建文件范围约束。
- `c:\Users\mrseven\Desktop\总经办文档\AGENTS.md`、`README.md`、`03-例会汇报\董事长例会\会议纪要\README.md`、`04-进度督察\通报与处罚存档\重大节点进度督察工作流程.html` — 同步规则和人类使用入口。
- `c:\Users\mrseven\Desktop\总经办文档\INDEX.md` — 仅通过生成脚本更新。

**Scope boundaries**
- 包含：闭环督办能力、会议纪要规范、正式工作事项台账、JK 编号流水、发布验证降噪、新周目录的未来规则。
- 不包含：批量重命名历史文件/目录、删除历史版本、自动处罚/自动签发、合同数据盲提取、Git LFS 迁移、录音自动转写、创建多智能体调度系统。
