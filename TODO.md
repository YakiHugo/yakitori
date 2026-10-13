# TODO：会话执行边界

2026-10-13：P0–P4 已落地，原问题描述与目标结构图已移除。后续以公开类型、实现和行为测试为准。

- [x] P0：合并公开操作，保留独立端点及唯一事件读取权。
- [x] P1：接受时登记任务并捕获配置，异步准备不阻塞控制队列。
- [x] P2：取消、资源结算和业务终态分别由明确的所有者处理。
- [x] P3：明确普通记录与用量、历史持久检查点的承诺。
- [x] P4：人工输入按 ID 核对，主动重发使用新身份；保留队列、问题答案和代理自动交付的实际恢复契约。
- [x] 独立核对 canonical 写入、fork/GC、导航/sidebar、搜索/用量投影的所有权；未将这些模块的结构调整混入执行协议迁移。
- [x] 核对 kernel/core 的契约归属；执行控制由 Session 持有，任务契约位于 `src/core/session-task.ts`。

重点验收：`test/core/session-endpoints.test.ts`、`test/core/session.test.ts`、`test/runtime/turn-processor.test.ts`、`test/runtime/openai-responses-transport.test.ts`、`test/server/computer-lifecycle.test.ts`、`test/gui-state/admission-recovery-rpc.test.ts`、`test/gui-state/app-store.test.ts`。

本轮没有增加 review、挂起/恢复或辅助 shell 的产品接口，也没有建立持久协作发件箱。
