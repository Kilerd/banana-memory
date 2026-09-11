# Banana Memory

在本机运行的项目记忆服务。Claude Code 通过一个全局 Agent Skill 决定何时召回和记录，通过 Streamable HTTP MCP 访问本机的 Qwen3、llama.cpp 和 LanceDB。

当前提供 **macOS Apple Silicon 本地试用版**。首次模型和运行时下载约 **2.48 GB**，请预留至少 8 GB 可用空间。当前完整验证机器是 M4 Pro / 48 GiB；16 GB 机器验证仍是正式发布门槛，详细证据见 [验收记录](docs/validation.md)。

## 安装与使用

需要 Node.js **22.23.1 或更高版本**和 Claude Code。正式 npm 包发布后，在第一个终端启动前台服务：

```sh
npx -y banana-memory@latest start
```

服务只监听 `127.0.0.1:3927`。终端会持续显示模型准备状态，并输出一条带本机访问 token 的 `claude mcp add` 命令。保持该终端运行；按 `Ctrl+C` 会安全关闭模型与数据库，已记录的数据和下载进度保留在 `~/.banana-memory`。

如果服务已经运行，再执行一次 `start` 会显示现有 MCP 地址和添加命令，然后正常退出，不会启动第二套模型进程。

一次性安装全局 Skill：

```sh
npx skills add Kilerd/banana-memory \
  --skill banana-memory \
  --global \
  --agent claude-code \
  --yes
```

复制服务启动时输出的命令，一次性添加全局 MCP：

```sh
claude mcp add \
  --transport http \
  --scope user \
  --header "Authorization: Bearer <本机生成的 token>" \
  -- \
  banana-memory \
  http://127.0.0.1:3927/mcp
```

之后在项目中启动 Claude Code 并照常工作。Skill 会在实质性任务开始时召回相关记忆，在可靠结论形成后记录精简的项目事实、偏好和结果。用 `/mcp` 查看连接状态；直接询问 Claude“查看 Banana Memory 状态”可以检查模型下载、队列和当前项目。

尚未发布 npm 包时，可以从源码验证同一路径：

```sh
npm ci
npm run build
node dist/src/cli.js start
```

可用 `BANANA_MEMORY_HOME` 将数据目录改为另一个绝对路径，也可用 `--port` 更改监听端口：

```sh
BANANA_MEMORY_HOME=/absolute/path node dist/src/cli.js start --port 4927
```

## 工作方式与边界

HTTP MCP 使用客户端提供的 `roots/list` 绑定当前项目。服务不会接受模型参数指定的工作区；无法取得可信文件根目录时，会退化到当前 MCP 会话独立的临时作用域，避免跨项目读取。

没有生命周期 hooks 时，记录由 Skill 驱动，而不是由宿主强制采集。通过 HTTP MCP 写入的材料始终标记为模型转述的 `candidate`，可以在 HTTP Skill 模式中召回，但不会伪装成用户直接确认的事实。当前插件模式仍保留更强的自动事件采集和一次性维护凭据，作为 Claude Code 专用的增强接入。

召回内容永远是带来源的历史材料，不是宿主指令。Skill 不应记录计划、猜测、普通进度、凭据、密钥或复制来的第三方指令。识别到的密钥字段会被过滤，但过滤无法识别所有敏感信息。

记忆抽取、聚合、向量生成和数据库均在本机。权重下载完成后，Banana Memory 可以离线处理；召回片段仍会交给 Claude Code，进入 Claude 的处理链路。

HTTP 服务使用持久随机 bearer token，并将其以仅当前用户可读的权限保存在 `~/.banana-memory/http-token`。MCP 接口只接受 loopback Host 和可信的本地 Origin。`/health` 仅返回服务是否运行，不泄露项目或模型信息。

## 开发与验证

```sh
npm run typecheck
npm test
npm pack --dry-run
npx skills add . --list
```

测试覆盖真实本地 LanceDB、HTTP MCP 握手与项目根绑定、Bearer 鉴权、Origin 拒绝、可控时钟、可重放模型输出和进程生命周期。独立的真实本地模型与 Claude 插件评测命令仍保留：

```sh
npm run probe:storage
npm run evaluate:replay
npm run evaluate:models
npm run evaluate:pipeline
npm run benchmark -- --models-dir .runtime/models
```

主要实现：`src/host/http.ts` 提供前台 Streamable HTTP MCP；`src/service.ts` 是业务入口；`src/store.ts` 提供单表原子发布和物理清理；`src/models/` 管理固定本地资源。旧的 Claude 插件、stdio MCP 与 hooks 位于 `plugin/` 和 `src/host/`，继续用于增强模式验证。
