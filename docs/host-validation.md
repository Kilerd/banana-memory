# Claude Code 宿主集成验收

验收日期：2026-09-10。固定客户端：**Claude Code 2.1.231**。运行时：**Node.js 22.23.1**，macOS 26.5.2 / arm64。使用真实 Claude Code 程序、真实 MCP SDK 和 Unix socket。模型质量与数据库回归分别记录，不能由本文件的通过结果替代。

## 固定安装形态

只有一种持久安装形态：同一个 Claude Code 插件包含 Skill、六个生命周期 hooks 和一个 STDIO MCP 服务。源码安装器先构建自包含本地 marketplace，再交给 Claude 官方安装命令，避免插件复制到缓存后丢失相对路径。没有虚构 npm 发布包或在线分发地址。

源码目录安装（先将 Node.js 22.23.1 放入 PATH）：

```sh
npm ci
npm run build
node scripts/install.mjs
```

安装器默认把本地 marketplace 放在 `~/.local/share/banana-memory/marketplace`，以 user scope 注册 `banana-memory@banana-memory-local`。默认记忆与模型目录为 `~/.banana-memory`，不放在可被 Claude 更新清除的插件缓存内。可以用 `BANANA_MEMORY_HOME` 显式指定测试数据目录。

隔离验收使用临时目标与独立 Claude 配置，不修改实际用户配置：

```sh
node scripts/install.mjs \
  --destination /tmp/banana-memory-host-validation/marketplace \
  --claude-config-dir /tmp/banana-memory-host-validation/claude
```

实际结果：插件 manifest validation 通过；本地 marketplace validation 通过；marketplace add 与 plugin install 均成功。更新后的 manifest 增加 marketplace description 后没有 validation warning。

`npm run package` 生成平台限定的 `artifacts/banana-memory-0.1.0-darwin-arm64.tar.gz`、SHA-256 文件以及包内 `INSTALL.md`。解压后的入口是一个本地 marketplace，**不是源码安装器**：

```sh
claude plugin marketplace add ./banana-memory-0.1.0-darwin-arm64
claude plugin install banana-memory@banana-memory-local
```

下载失败后显式重试的源码命令为 `node dist/src/cli.js models-retry`；发行包对应 `node ./banana-memory-0.1.0-darwin-arm64/banana-memory/runtime/dist/src/cli.js models-retry`。重试仍由唯一内核执行，命令保持连接直到准备完成。卸载用 `claude plugin uninstall banana-memory@banana-memory-local` 或源码 `node scripts/install.mjs --uninstall`；保留独立的记忆和模型目录。

## 自动入口与权限边界

- SessionStart、UserPromptSubmit、PostToolUse、PostToolUseFailure、Stop、SessionEnd 都使用官方 command hook 的 `args` 形式，避免路径中的空格被 shell 拆分。宿主 timeout 固定为 1 秒，进程内另设 900 毫秒退出期限。超时或不可用都退出 0，不阻断主任务。
- SessionStart / UserPromptSubmit 返回 `hookSpecificOutput.additionalContext`。Stop 仅表示回合结束，工具成功只标为 `tool_success`，都不直接认定任务成功。
- MCP 和 hook 从宿主提供的 `CLAUDE_PROJECT_DIR` 取得工作区，再取真实路径；不从模型参数或 JSON `cwd` 取得项目权限。缺失或不唯一时退到会话范围并给出原因。同名目录使用各自完整真实路径。
- Claude 2.1.231 的 hook exec 子进程和 MCP 子进程具有相同宿主父进程。内核用这个父进程绑定 hook 的 session ID，实际冒烟已验证 MCP 收到同一 ID。尚未获得 hook 会话映射的 MCP 使用自己的隔离会话身份。
- 只有 UserPromptSubmit 中完全匹配的顶层 `/banana-memory:memory ...` 原文可签发维护意图。引用、代码围栏、普通文本、子代理事件和 MCP 工具调用不能签发意图。MCP manage 只接收 token，不能改变签发动作或参数。
- Unix socket 权限 0600、父目录 0700，并校验本地认证串。数据库写入者使用带心跳的排他锁；失去锁立即终止，崩溃后可以恢复过期锁。最后会话退出后默认 5 秒等待加至多 55 秒排空，总期限不超过 60 秒。

这些边界隔离 MCP 参数与宿主权限。它们不是针对已经具有同一操作系统用户完整文件与进程权限的恶意程序建立的沙箱。

采集对 Bash 采用保守边界：任意 shell 命令及其输出均不保存，只保留工具发生、成功或失败、会话和事件标识，以及 `unverified_shell_scope` 过滤原因。不能从 shell 命令字符串证明输出来自当前工作区，因此即使 `cat notes.txt` 看起来是相对路径也不采集正文。唯一例外是明确工作区内成功执行的精确单条 `node/npm/pnpm/python/python3 --version`：只保留唯一解析出的数字版本与归一化运行时名称，舍弃命令原文和所有附带输出；无法解析、组合命令、失败或工作区未知均过滤。`python3` 统一为 `python`，`Node.js` 统一为 `node`。普通文件工具继续执行工作区真实路径、外部符号链接及凭据文件过滤。

官方依据：[插件的 MCP、缓存与路径规则](https://code.claude.com/docs/en/plugins-reference)、[生命周期 hooks 和输入输出语义](https://code.claude.com/docs/en/hooks)、[MCP 工作区环境](https://code.claude.com/docs/en/mcp)、[本地 marketplace 安装](https://code.claude.com/docs/en/plugin-marketplaces)。

## 可重复检查与结果

普通宿主契约测试：

```sh
node --import tsx --test tests/host.test.ts
```

实际 Claude 程序冒烟（先用安装器准备插件）：

```sh
BANANA_CLAUDE_SMOKE_PLUGIN=/tmp/banana-memory-host-validation/marketplace/banana-memory \
  node --import tsx --test tests/host.test.ts
```

最后一次完整运行：**7 个通过，0 个失败，0 个跳过**，约 2.93 秒。默认不设置 smoke 路径时只执行普通 6 项，并明确跳过真实宿主用例。

| 检查 | 实际结果 |
|---|---|
| 顶层维护授权 | 合法动作识别；引用、围栏、额外行、子代理与普通工具事件不授予意图；支持实际 `m:...` 与 `preview:...` ID |
| 采集与隐私 | 凭据文件、跨工作区文件和指向外部的符号链接过滤；已识别密钥字段脱敏；长结果标注截断；同事件重复 10 次保持同一个 ID |
| 内核与权限 | 第二内核不取得写锁；socket 为 0600；MCP 伪造 projectId 和 hook 调用被拒；关闭最后会话后执行 backend.close |
| MCP 握手 | 使用 SDK Client 与真实 STDIO 子进程；backend 尚未完成初始化时已经完成 handshake 与 listTools，固定暴露 5 个工具 |
| hook 超时 | 让 backend 延迟超过期限；hook 退出 0，stdout 没有过时上下文，主调用继续 |
| Claude 2.1.231 真实程序 | 使用独立配置与本地 API 夹具；真实 SessionStart、UserPromptSubmit、Stop 被触发；slash 原文得到 pause 意图；additionalContext 进入 API 消息；Claude 实际执行 MCP manage，token 与可信 session ID 正确传到 backend |

真实宿主冒烟中的 Anthropic API 使用回环地址的确定性夹具，backend 也使用可控夹具。没有读取或输出实际账号凭据，没有向远程模型发送测试正文。此结果验证客户端安装、事件语义、协议与会话绑定；**不宣称验证了真实模型的记忆质量、整套存储与模型链路，或公开配置硬件的性能目标**。

本机受限执行环境默认禁止监听 Unix socket。集成测试在允许本地 socket 的执行环境运行；将此权限错误混同为产品协议故障是不准确的。

## 模型进程随内核退出

`src/models/supervisor.ts` 用独立的轻量进程持有唯一一个模型子进程。内核保持通向 supervisor 的输入管道；内核被 SIGKILL 时，管道 EOF 仍会触发模型停止。supervisor 先发送 SIGTERM，最多 5 秒后只向自己创建的模型发送 SIGKILL 并回收退出状态。正常 TERM/KILL 请求也经此管道转发，避免先杀死 supervisor 而留下模型。

`node --import tsx --test tests/process-lifecycle.test.ts` 实测 **3 项通过**：强杀模拟内核后忽略 TERM 的模拟模型仍在期限内退出；正常 TERM 后强制 KILL 正确回收模型；模型自然退出码保留。测试只创建和终止自己的后代进程。
