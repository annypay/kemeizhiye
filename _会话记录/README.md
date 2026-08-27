# 会话记录（Copilot）

> 本目录保存 VS Code Copilot 的**会话历史**与**记忆文件**，随仓库提交推送，便于换电脑后无损接续。
> 内容由 `node scripts/sync_chat.js` 同步生成，**不要手工编辑**。

## 为什么需要同步脚本

VS Code 把聊天记录存放在用户目录的 `workspaceStorage/<工作区哈希>/` 下，且**不支持**把该位置指向项目文件夹；哈希在每台电脑上都不同。因此采用「仓库内保存 + 双向同步」：仓库是可移植的权威副本，脚本负责把它放回当前电脑的正确位置。

## 目录内容

| 子目录 | 来源 | 作用 |
| --- | --- | --- |
| `chatSessions/` | `workspaceStorage/<哈希>/chatSessions/` | 会话正文，决定 Chat 面板能否看到历史对话 |
| `memories/` | `GitHub.copilot-chat/memory-tool/memories/` | 仓库记忆与会话记忆（`repo/ops.md` 等） |
| `transcripts/`、`chat-session-resources/` | 同名目录 | 仅 `--full` 时同步，用于长会话回溯 |

不同步：`state.vscdb`、`codebase-external.sqlite`、`debug-logs/`、`chatEditingSessions/` —— 属于本机索引、日志和编辑快照，跨机器无意义。

## 用法

```bash
node scripts/sync_chat.js --status            # 查看两侧文件数量与时间
node scripts/sync_chat.js --export            # 工作结束：VS Code → 仓库
node scripts/sync_chat.js --import            # 换电脑：仓库 → VS Code
node scripts/sync_chat.js --export --full     # 连同 transcripts 一起备份
node scripts/sync_chat.js --import --force    # 强制覆盖本机较新的文件
```

## 换电脑接续步骤

1. `git clone` 或 `git pull` 本仓库；
2. 用 VS Code **打开该文件夹一次**（这样才会生成本机的工作区存储目录）；
3. 运行 `node scripts/sync_chat.js --import`；
4. 重新加载 VS Code 窗口，Chat 面板即可看到全部历史会话。

## 注意事项

- 导入默认不覆盖本机更新的文件；确需以仓库为准时加 `--force`；
- 会话内容包含文档正文与终端输出，**不要在对话里粘贴密码、密钥或个人敏感信息**；
- 会话文件是追加式 JSONL，体积会随对话增长，建议在阶段性收尾时再 `--export`，不必每次提交都导出；
- 会话格式由 VS Code 内部定义，跨大版本升级后如无法加载，以文本形式查阅仍然有效；
- 仓库通过 `.gitattributes` 对本目录关闭换行转换，保证 Windows/macOS/Linux 之间字节一致；
- 本目录不纳入 `INDEX.md` 全文索引，避免 UUID 文件名淹没业务文档。
