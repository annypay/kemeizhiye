# 总经办文档库 · 运维要点

- 常驻规则在根 `AGENTS.md`（自动注入）；技能 `.github/skills/` 包含 doc-intake、repo-publish、weekly-meeting、meeting-minutes、work-tracker、jk-notice；提示包含 report-gap、who、work-status。
- `04-进度督察/工作台账/工作事项总台账.md` 是执行状态唯一来源；事项用 `JK-RW-YYYY-NNNN`，关闭必须有复查日期和可定位证据，通报 `JK-YYYY-NNNN` 仅在确认签发后按流水表分配。
- `check_repo.js` 默认模式当前有 **28 项已知历史告警**（重复后缀/大文件/1 个锁文件，对应 README 第九节 TODO）；提交前使用 `--staged` 仅检查本次暂存内容。
- 提交流程：逐个 `git add`（勿 `-A`）→ `check_repo.js --staged` → 台账变更时 `check_work_ledger.js` → `gen_index.js` → 暂存 INDEX.md → 中文 commit（docs:/feat:/chore:）→ push（代理已全局配置）。
- 终端管道对中文 pattern 的 Select-String 可能因编码失效；优先用 ASCII 标记、匹配数量或 Node 直接读取 UTF-8 输出校验。
- **禁止用 PowerShell 5.1 的 Get-Content/Set-Content 批改中文文件**（按系统编码读写会产生乱码）；批量改写一律用 `node -e` 以 UTF-8 读写。
- 会话与记忆随仓库迁移：`_会话记录/`（chatSessions + memories），用 `node scripts/sync_chat.js --status|--export|--import [--full] [--force]`。换机器：git pull → VS Code 打开文件夹一次 → `--import` → 重载窗口。
- `.gitattributes` 对 `_会话记录/**` 关闭换行转换（README 除外），保证跨平台字节一致；`gen_index.js` 已排除该目录。
- 根目录白名单：README/INDEX/AGENTS/.gitignore/.gitattributes/.markdownlint.json。
- Markdown 规范：MD060=compact；MD040/MD060/MD047 已全库清零，剩余 MD013 长行等属历史内容类，不做机械改写。
- 2026-08-27 已发布闭环督办体系，提交 `6b5319a`；后续专项候选为 contract-ledger 和自动化强约束，暂不引入自动签发、自动处罚、多智能体或历史批量重命名。
