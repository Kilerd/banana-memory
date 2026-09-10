# Banana Memory

Claude Code 的自动本地项目记忆。一个插件包含 MCP、Skill 和生命周期 hooks；记忆处理使用本机 Qwen3 + llama.cpp，所有权威数据保存在一个 LanceDB 数据库中。

当前提供 **macOS Apple Silicon 本地试用版**。PRD 的 16 GB 目标机器验证和真实任务价值对比仍是公开发布门槛，详细证据与限制见 [验收记录](docs/validation.md)。不包含云同步、管理后台或远程记忆推理。

## 安装

需要 Node.js **22.23.1**、Claude Code **2.1.231** 和至少 8 GB 可用磁盘。首次模型和运行时下载约 **2.48 GB**。模型运行内存不能由下载体积推断，当前测试机器是 M4 Pro / 48 GiB。

从源码安装同一个 Claude 插件：

```sh
npm ci
npm run build
node scripts/install.mjs
```

重启 Claude Code，按宿主提示信任插件和 hooks，然后执行：

```text
/banana-memory:memory status
```

安装器使用本地 marketplace，固定当前 Node 可执行路径，不修改其他插件。首次 MCP 启动即后台准备模型，不阻塞协议握手；准备过程中先可靠接收事件。运行时默认位于 `~/.banana-memory`，可用 `BANANA_MEMORY_HOME` 改为另一个绝对路径。

可直接使用本地打包制品：

```sh
npm run package
tar -xzf artifacts/banana-memory-0.1.0-darwin-arm64.tar.gz
claude plugin marketplace add ./banana-memory-0.1.0-darwin-arm64
claude plugin install banana-memory@banana-memory-local
```

制品包含运行依赖与许可声明，模型在首次启动时下载。没有虚构的 npm 包或公开下载仓库。

运行 `npm run site` 打开唯一安装说明页：<http://127.0.0.1:4318>。本地下载链接指向 `artifacts` 下实际生成的发行包。

## 日常使用

项目事实在 UserPromptSubmit 时记录；工具结果和回合结束信息由 hooks 记录。在 Stop、积累 20 条事件或后台调度时自动整理，新任务自动召回。Stop 和工具成功都不会自动宣称整个任务已完成。

| Claude 命令 | 用途 |
|---|---|
| `/banana-memory:memory status` | 就绪状态、当前项目、队列和错误类别 |
| `/banana-memory:memory inspect <id>` | 查看原文来源、版本、条件与变更原因 |
| `/banana-memory:memory correct <id> <version> <text>` | 立即纠正，旧向量未回填也不能覆盖新事实 |
| `/banana-memory:memory forget <id> <version>` | 只读预览整条来源事件与派生影响范围 |
| `/banana-memory:memory confirm-delete <previewId>` | 确认该预览后屏蔽并清理旧版本 |
| `/banana-memory:memory pause` / `resume` | 暂停或恢复采集、召回和后台发布 |
| `/banana-memory:memory pin <id> <version>` / `unpin <id> <version>` | 固定或取消固定；不覆盖过期、纠正和环境失效 |
| `/banana-memory:memory complete-task <taskId>` | 明确完成已知任务，归档其临时状态 |

写操作仅接受顶层用户命令签发的一次性、会话和项目绑定凭据。MCP 的模型输入无法伪造 `user_confirmed` 或取得另一个工作区的权限。正文永远作为带来源材料注入，不能升级成宿主指令。

从原始来源保守抽取事实、偏好和经历，不让自由摘要丢失否定、版本与例外。相似经历只有在条件、数字与否定兼容时聚合；至少 3 个独立任务、跨 2 个会话的明确可核验结果才可晋升条件化经验。引用、模型自述、重复事件和工具退出码不能单独满足门槛。

临时状态由来源中的 `当前任务状态`、`临时任务状态`、`任务进行中`、`current task state`、`temporary task` 或 `work in progress` 标记识别。明确到期支持 `有效期至` / `到期时间` / `expires at` / `valid until` 后的 ISO 日期或 UTC 时间；日期按该日 UTC 结束计。自然语言环境依赖首版识别 Node.js、macOS、Python、pnpm、npm 的显式版本，以及条件中的 `key=value`。不能解析的自然语言条件仍随原文交付，使用者需要核对。

## 下载恢复与卸载

检查失败原因并排除磁盘或网络问题后，显式重试：

```sh
node dist/src/cli.js models-retry
```

发行包对应路径为 `banana-memory-0.1.0-darwin-arm64/banana-memory/runtime/dist/src/cli.js`。命令保持连接，已校验的权重不会重新下载；损坏临时文件不会被加载。模型版本和 SHA-256 在 [固定清单](models/manifest.json) 中。

```sh
node scripts/install.mjs --uninstall
# 或发行包安装后的等价操作
claude plugin uninstall banana-memory@banana-memory-local --scope user
```

卸载仅移除集成，保留本地记忆和模型。删除操作覆盖本产品的来源、派生记录、向量、缓存和旧数据库版本；不包含 Claude 历史、手工导出、系统备份，也不承诺介质取证级擦除。

只摄入当前可信工作区内由宿主提供的事件，不导入全部历史、不扫描整台电脑。识别到的密钥字段和凭据文件会被过滤；过滤不保证识别全部敏感信息。诊断日志仅包含类别、标识与计时。模型下载后，本产品可离线处理记忆；交给 Claude Code 的上下文仍进入 Claude 的处理链路。

## 开发与验证

```sh
npm run typecheck
npm test
BANANA_CLAUDE_SMOKE_PLUGIN=artifacts/banana-memory-0.1.0-darwin-arm64/banana-memory npm test
npm run probe:storage
npm run evaluate:replay
npm run evaluate:models
npm run evaluate:pipeline
npm run benchmark -- --models-dir .runtime/models
```

测试使用真实本地 LanceDB、可控时钟、可重放模型输出，以及独立真实本地模型评测。Claude 冒烟使用真实客户端和本地 API 传输夹具，验证插件和 hooks，不替代真实任务成功率评价。

主要实现：`src/service.ts` 是唯一业务入口；`src/store.ts` 提供单表原子发布和物理清理；`src/models/` 管理固定本地资源；`src/host/` 处理可信适配、MCP、受限 IPC 和单实例生命周期。进程退出后持久队列在下次恢复；内核被强杀后，监督进程会回收它自己启动的模型。
