---
name: repo-publish
description: '检查并发布仓库变更：卫生检查、重建 INDEX 索引、审查暂存、中文提交、代理推送、同步验证。Use when: 用户说"提交"、"推送"、"发布"、"更新索引"，或其他技能（如 doc-intake）收尾。'
---

# 检查与发布

## 流程

1. `git status --short` 确认变更范围；`00-临时存放/` 新文件默认不提交（铁律）；
2. `git add` 逐个指定目标文件，禁止无差别 `git add -A`（避免裹挟临时区半成品）；
3. `node scripts/check_repo.js --staged`：本次暂存内容的新增违规必须先处理；默认全库检查仅用于卫生审计，现有重复后缀/大文件/锁文件告警按 README 第九节 TODO 处理，不扩大本次范围。
4. 若暂存内容涉及 `04-进度督察/工作台账/`，运行 `node scripts/check_work_ledger.js`；校验不通过不得提交。
5. `node scripts/gen_index.js`，然后 `git add INDEX.md`；再次运行 `node scripts/check_repo.js --staged`。
6. 审查：`git diff --cached --check`（空白错误）与 `git diff --cached --name-status`（范围仅限本次）；
7. 中文 commit：前缀 `docs:`（文档）/ `feat:`（新目录或体系）/ `chore:`（脚本维护）；
8. `git push origin master`；
9. `git status -sb` 确认 `master...origin/master` 无 ahead/behind，工作区干净。

## 推送失败排查

| 现象 | 动作 |
|------|------|
| 连接超时 | 确认 v2rayN 开启且 10808 端口监听（`Get-NetTCPConnection -State Listen`） |
| 端口正常仍失败 | `curl.exe -x socks5://127.0.0.1:10808 -sS -o NUL -w "HTTP:%{http_code}" https://github.com` 应返回 200 |
| 需切换直连/恢复代理 | 按 README 8.4 的 git config 命令操作 |
