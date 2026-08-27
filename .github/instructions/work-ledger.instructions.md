---
description: 'Use when creating or editing the work-item ledger under 04-进度督察/工作台账. Enforces evidence-based closure, stable IDs, sources, and status updates.'
applyTo: '04-进度督察/工作台账/**/*.md'
---

# 工作台账约束

- `工作事项总台账.md` 是执行状态唯一来源；每项保留原始来源，不能删除或重用既有 `JK-RW` 编号。
- 只有填写复查日期和可定位证据/归档路径后，才能将事项标为“已关闭”。
- “暂缓”或“已撤销”必须在“说明/下一步”中保留原因；不确定责任、期限或结论时标记“待明确”，不要臆测。
- 修改台账后运行 `node scripts/check_work_ledger.js`。