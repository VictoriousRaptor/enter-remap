# enter-remap — 输入框 Enter 键位轮换（Hermes Desktop 桌面插件）

参考 [fleps/hermes-desktop-enter-swap-plugin](https://github.com/fleps/hermes-desktop-enter-swap-plugin)
的思路，把输入框的三个键轮换一位：

| 按键 | 原版 | 装本插件后 |
| --- | --- | --- |
| `Enter` | 发送（回合运行中 = steer） | 换行 |
| `Shift+Enter` | 换行 | 排队后续轮次（回合运行时空闲无动作） |
| `Ctrl/Cmd+Enter` | 排队后续轮次 | 发送（空闲）/ steer（回合运行中） |

其余全部保持原样：`Ctrl+Shift+Enter`、`Alt` 组合、`@` / `/` 补全列表里 Enter
选中条目、中文输入法确认上屏、`Ctrl+Shift+K` 排空队列，都不受影响。

## 原理（一句话版）

在捕获阶段抢在 React 前面拦下 keydown，然后**改发一个合成事件**，让应用自己
的提交逻辑去处理：

- `Enter` → 插入换行（`execCommand('insertLineBreak')`，走真实 input 事件，
  草稿同步和撤销历史不受影响）
- `Shift+Enter` → 合成一个 `Ctrl+Alt+Enter` → 核心走排队（`composer.queue`）
- `Ctrl/Cmd+Enter` → 合成一个 `Alt+Enter` → 核心走发送 / steer
  （`composer.send` / `composer.steer`）

合成「发送」如果没被应用接住（有没有接住由插件自检），会自动**兜底点击输入框
旁边的发送按钮**——同一条核心提交路径，只是换成走 DOM 按钮而不是键盘管线；
仅在空闲时兜底（回合运行中那个按钮是「停止」）。

合成事件额外带 `alt` 修饰并打上内部标记：核心的 Enter 分支不看 alt
（源码里发送/排队两个分支都只判断 shift 与 ctrl/meta），所以路由不变；
而另一个键位插件（或本插件的重复加载实例）会把带修饰键的合成事件原样放行，
不再互相抢——没有这两道防线时，第二个处理器会把合成事件当普通 Enter 执行换行，
症状就是「三个键全变换行、消息发不出去」。

**与 enter-swap（Enter / Shift+Enter swap 插件）共存**：两者都在改同一批键，
同时启用会互相抢事件。新版本身扛得住（Ctrl+Enter 发送两种注册顺序都验证过），
但 Shift+Enter 的「排队」在它抢先注册时仍会被它吃掉——**要完整三键，请只启用
本插件，把 enter-swap 禁用或删掉**。

这是 hack 而不是官方能力：核心把 `composer.send` / `composer.newline` /
`composer.queue` 的键位标成只读（
[`actions.ts` KEYBIND_READONLY](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/src/lib/keybinds/actions.ts)，
提交逻辑在
[`composer/index.tsx handleEditorKeyDown`](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/src/app/chat/composer/index.tsx)）。
上游对应的功能请求是
[issue #49422](https://github.com/NousResearch/hermes-agent/issues/49422)
（P2，2026-06-20 提出，仍开放）——官方支持改键后可以删掉本插件。

它依赖两个内部 DOM 契约（slot 名 `composer-rich-input`、
`composer-completion-drawer`）。如果以后版本改了名，插件探测不到编辑器就
**自动退化成原版键位**（加载时会弹提示），不会把输入框搞坏。

## 安装

桌面 App 明确读不到远程网关（NAS）那侧的磁盘，插件必须放在**运行 Hermes
Desktop 的这台机器**上：

1. Hermes Desktop → **Settings → Plugins** → 点「打开插件文件夹」按钮
   （reveal 按钮，就是插件页里打开文件夹的那个）。
2. 把整个 `enter-remap/` 文件夹放进去（文件夹名必须叫 `enter-remap`，
   要和插件 id 一致）。
3. 几秒内自动加载。没有的话按 `Cmd/Ctrl+K` → **Reload desktop plugins**。
4. **Settings → Plugins** 里出现 `Enter remap · Ctrl+Enter 发送 / Enter 换行 /
   Shift+Enter 排队` 即装好。

## 开关与诊断（`Cmd/Ctrl+K` 命令面板）

- **切换 Enter 键位重映射** —— 临时开/关，重启后保持你的选择
- **诊断 Enter 键位重映射** —— 报告编辑器 slot 找没找到，用于升级 App 后排查

## 排错

- 「没找到输入框编辑器」提示 → 插件加载后会探测 8/30/90 秒三轮，三轮都找不到
  （＝期间没有打开的会话）才报警；打字时若真没接管会另弹一条「键位未接管」。
- Ctrl+Enter 发不出去时若弹过「已改为点击发送按钮兜底」→ 合成按键没被应用接住，
  此时发送仍然可用（走按钮），但 steer/排队还依赖合成按键——运行 ⌘K
  「诊断 Enter 键位重映射」，把输出里的「最近按键」轨迹发给哈基米定位。
- 三个键都变成换行、消息发不出去 → 有第二个键位处理器：Settings → Plugins
  里禁用 enter-swap（或删掉重复的插件文件夹），再用本版本覆盖 plugin.js。

## 卸载

- 临时：上面的切换命令，或 Settings → Plugins 里禁用
- 彻底：删掉 `enter-remap/` 文件夹
