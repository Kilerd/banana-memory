# M0 本地存储验证

验证时间：2026-09-10。结论：**LanceDB 0.38.0 可以继续作为首版统一存储实现**。本记录只覆盖存储；模型质量、真实 Claude Code 自动闭环与 16 GiB 目标机性能仍须分别验收。

## 实际发行版与机器

| 项目 | 本次实际值 |
| --- | --- |
| SDK | npm 正式发行 `@lancedb/lancedb@0.38.0`，Apache-2.0 |
| Arrow | `apache-arrow@18.1.0` |
| Node | `22.23.1`；SDK 要求 Node ≥22 |
| OS | macOS 26.5.2，Darwin 25.5.0，arm64 |
| 硬件 | Apple M4 Pro，48 GiB 内存 |
| 安装 | npm 安装预编译 Darwin arm64 原生包，无本地编译步骤 |
| 推理、云与额外数据库 | 本探测不运行模型、不使用 LanceDB Cloud，也没有第二个权威数据库 |

版本来自实际 npm registry 元数据及安装后的 SDK 声明，不以主分支接口代替发行包。本机成功安装尚不等同“空白用户环境从安装网页完整安装”验收，也不等同 16 GiB 支持承诺。

## 持久化与发布契约

只使用一个 `records` 权威表，固定列为 `id`、`kind`、`projectId`、`version`、JSON `data`、可空 `text`、可空 1024 维 Float32 `vector`。事件、记忆、来源关系、项目、任务队列、控制状态、上下文包和无正文 tombstone 均存入该表。关系由带来源和版本的记录表达，不宣称原生属性图或通用多跳查询。

`UnifiedStore.commit(records)` 在整个批次校验和 Arrow 转换完成后，只执行一次 `mergeInsert('id').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(batch)`。业务层须把记忆、来源依赖、队列结果及控制代次放在同一批次。此入口不启用 LSM / MemWAL。数据库提交失败时，存储对象没有可被污染的记录缓存；业务缓存也必须在持久化成功后更新。

内核必须持有当前用户的单写入锁，并串行执行读取、提交及清理。连接固定 `readConsistencyInterval: 0`；不会依赖默认快照缓存决定纠正何时可见。`get/all` 返回权威记录，检索返回候选；项目授权、暂停、来源撤回、生命周期及交付前控制代次复查仍由 Memory Service 完成。

连接显式设置 SDK Session 缓存预算为索引 256 MiB、元数据 64 MiB。实际发行包默认分别为 6 GiB 和 1 GiB，完整规模探测曾观察到 Node RSS 约 2.8 GiB，因此不沿用默认预算。缓存预算不等于进程总 RSS；JavaScript 数据、原生查询缓冲、模型进程仍需实测。

文本通道使用原生 ICU FTS，另外用 SQL 字面量转义的精确子串匹配保留错误码和中文字符串，在索引未建立时也可读取。向量通道使用 cosine，256 条向量后可建立单分区 IVF Flat 索引。两通道均限制至 20 个本项目 memory 候选，没有启用跳过未索引片段的 `fastSearch`。索引维护是可重建加速，不发布独立事实状态。

日常 `compact()` 在独占访问下压合数据碎片、增量更新已有索引、移除过期物理快照。Memory Service 每 200 次发布调度一次。逻辑历史是权威表中的独立 history 记录，物理快照清理不会删除这些记录。索引维护本身可能再生成一个版本，所以普通 compaction 不承诺仅剩一个物理版本；显式删除使用后述更严格的无旧索引重写路径。

## 删除覆盖范围

Memory Service 先持久化 tombstone 和来源撤回，立即阻止默认读取与在途任务再发布，再调用 `purge(ids)`。清理包括：

1. 枚举并删除此产品私有数据库的 tag 和 branch；首版没有创建它们的产品入口。
2. 删除当前目标行，丢弃旧索引，并重写全部存活行，使低比例删除的正文也退出当前数据文件。
3. `optimize({ cleanupOlderThan: new Date(), deleteUnverified: true })` 清理旧版本和孤立文件。只有在内核独占数据库时才允许此参数。
4. 再查询版本、tag、branch。只有仅保留当前版本、无 tag、无 branch 才报告 `complete: true`；抛错或不满足条件不能对用户报告物理清理完成。

清理全部行时，真实 SDK 的 `add` 不接收零批次 Arrow 表，因此使用 `createEmptyTable(..., { mode: 'overwrite' })` 的空表覆盖入口，随后执行同样的历史清理。此路径已实测，清空后仍可正常写入。

清理之后检索可以使用文本/向量扫描，索引由后台后续重建。清理时间与当前存活数据量有关，不能放进短 hook 请求期限。若清理中断，业务层须保留无正文 tombstone 及待清理工作；重新启动后重试。删除不覆盖 Claude 历史、用户导出、系统备份或介质取证擦除。

## 实际探测结果

通过 `npm run probe:storage` 可独立重现以下探测；脚本在随机临时目录创建真实数据库，结束后删除探测目录。2026-09-10 14:05:49 UTC 的执行结果：

| 检查 | 实际观察 |
| --- | --- |
| 单次发布 | 5 个不同对象，版本 1 → 2，只产生一个新表版本 |
| 事件重试 | 重复提交 10 次，逻辑事件仍为 1 条 |
| 未索引新数据 | FTS 已索引 261 条、未索引 1 条；原生 FTS 直接查到新增错误码，向量查到新增向量 |
| 纠正 | 记忆版本 2 同步可见，原生 FTS 不再返回旧错误码；向量返回新版本 |
| 旧数据保留 | 清理前 18 个历史版本，另有人为创建的 tag、branch |
| 物理清理 | 清理 2,231,963 字节；只剩版本 24，tag 和 branch 均为空 |
| 正文文件检查 | 删除哨兵字符串在清理前出现于 11 个文件，清理后为 0 个；检查包含数据库全部子目录 |
| 强杀恢复 | 子进程确认一次持久化后 SIGKILL；64 条事件/任务全部恢复为同一完整代次，已删除来源未再现 |

测试还覆盖中途无效向量导致整个批次拒绝、旧记录版本不变；项目名称和查询中的 SQL 形状字符串不能扩大范围；无向量记录可持久化；删除最后一行后可重新写入；分支独有正文和分支保留 tag 也能被清理；日常压合保留全部逻辑 history 且更新索引。`tests/store.test.ts` 的 8 个真实数据库测试全部通过。

约 260 行的小型存储微基准执行 50 轮串行文本＋向量检索，本次 p50 为 3.70 ms、p95 为 5.18 ms，执行进程 RSS 约 205.1 MiB。**这些值不包含查询 embedding、Memory Service、适配器或 Claude，不能用于声称满足 20,000 事件 / 5,000 记忆 / 双会话 / 16 GiB / 500 ms 的 PRD 性能目标。**

哨兵文件扫描是本次物理清理的可核查证据，不等同对任意压缩、系统备份或介质残留的安全擦除证明。SIGKILL 测试证明观测到的提交代次没有半批发布，不能代替所有文件系统、断电与磁盘损坏故障测试。

## 官方依据

- [Node Table SDK](https://lancedb.github.io/lancedb/js/classes/Table/)：同表 mergeInsert、版本、索引、tag 与 branch 接口。
- [OptimizeOptions](https://lancedb.github.io/lancedb/js/interfaces/OptimizeOptions/)：历史清理参数及 `deleteUnverified` 对独占访问的要求。
- [版本与 tag 保留](https://docs.lancedb.com/tables/versioning)：旧版本及 tag 可继续保留数据。
- [读取一致性](https://docs.lancedb.com/tables/consistency)：显式配置读取刷新行为。
- [更新与删除](https://docs.lancedb.com/tables/update)：软删除、未索引增量与维护边界。
- [SDK npm 发行入口](https://www.npmjs.com/package/@lancedb/lancedb)：本次固定使用 0.38.0；未来最新版不能自动替换验收版本。
