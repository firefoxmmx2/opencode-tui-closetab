# opencode-tui-closetab

> 本文件为中文版，English version: [README.md](./README.md)

> ⚠️ **学习用途 / For learning purposes** — 本项目仅用于学习 OpenCode V2 插件开发，接口为 beta API，可能随版本变化，请勿用于生产环境。

OpenCode V2 的 TUI 插件，实现 `/close` 命令关闭会话标签页。**学习/演示用途**。

## 功能

在 TUI 中输入斜杠命令 `/close`，支持以下用法：

| 用法 | 说明 |
| --- | --- |
| `/close` | 关闭当前活动标签页 |
| `/close 3` | 关闭第 3 个标签页 |
| `/close 1,3,5-7` | 序号/区间多选关闭（逗号分隔，`a-b` 为闭区间，越界整体校验） |
| `/close <关键词>` | 按标题匹配；恰好一个匹配时直接关闭 |
| `/close <关键词>`（多个匹配） | 弹出多选选择器：默认全部勾选、`空格` 切换勾选、过滤框禁空格（空格保留给勾选切换）、`回车` 确认关闭、`Esc` 取消 |

无需二次确认，关闭即关闭；会话内容不会删除，可稍后在会话列表重新打开。

## 环境要求

- OpenCode V2（文档：<https://opencode.ai/v2/docs/build/plugins/cli>）
- 依赖：`@opentui/core`、`@opentui/solid`、`solid-js`（见 `package.json` 的 peerDependencies）

## 安装 / 加载方式

二选一：

**1. 作为包安装**

在全局 `cli.json` 或项目 `opencode.json` 的 `plugins` 数组中添加包名：

```jsonc
{
  "plugins": ["opencode-tui-closetab"]
}
```

**2. 本地开发（无需打包）**

把 `src/tui.tsx` 放到全局配置目录的 `plugins/tui/` 下即可被自动发现：

```
<global-config>/plugins/tui/tui.tsx
```

## 项目结构

```
opencode-tui-closetab/
├── package.json      # npm 包元数据（exports 暴露 ./ 与 ./tui 两个入口）
├── src/
│   ├── index.ts      # 主入口：声明插件 id 并标记 tui: true
│   └── tui.tsx       # TUI 入口：/close 命令实现（含自定义 JSX 多选 dialog）
├── README.md
└── LICENSE           # MIT
```

- `src/index.ts`：主入口，标记 `tui: true`，由 OpenCode 加载以关联 TUI 入口。
- `src/tui.tsx`：TUI 侧实现。核心要点：
  - keymap 命令必须在 `ui.slot` 的 `render` 回调（组件上下文，含 `Keymap.Provider`）中注册，不能在 `setup()` 中直接调用 `ctx.keymap.layer()`；
  - 多选选择器用 `ctx.ui.dialog.show(() => JSX)` 渲染自定义 Solid 组件，键盘处理使用 `@opentui/solid` 的 `useKeyboard`；
  - 中英文自动适配（`options.locale` 或系统 `LANG`/`LC_ALL`）。

## 免责 / 学习声明

- 本插件**仅用于学习** OpenCode V2 插件开发，非官方项目。
- 所依赖的插件 API（`@opencode-ai/plugin`、`@opentui/*`）均为 **beta API**，可能随版本变化而破坏兼容性。
- 使用风险自负，请勿用于生产环境。

## License

[MIT](./LICENSE)
