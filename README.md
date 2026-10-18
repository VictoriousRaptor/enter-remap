# enter-remap

Hermes Desktop 输入框 Enter 键位轮换插件 / Rotate the composer's Enter keys in Hermes Desktop.

把三个键轮换一位 / Rotate the three keys by one:

| 按键 Key | 原版 Stock | 装本插件后 With this plugin |
| --- | --- | --- |
| `Enter` | 发送 Send | 换行 Newline |
| `Shift+Enter` | 换行 Newline | 排队 Queue a follow-up |
| `Ctrl/Cmd+Enter` | 排队 Queue | 发送 / steer Send / steer |

其余按键、`@` / `/` 补全、中文输入法均不受影响。/ All other keys, the completion drawer and IME input are untouched.

## 安装 Install

Hermes Desktop → **Settings → Plugins** → **Install from Git**，粘贴本仓库地址 / paste this repository URL:

```
https://github.com/VictoriousRaptor/enter-remap
```

几秒内自动加载。/ It loads within seconds.

手动安装（备选）/ Manual (alternative): 打开插件文件夹，把本仓库放进去，文件夹名保持 `enter-remap`。/ Reveal the plugins folder and drop this repository in, keeping the folder name `enter-remap`.

插件装在**运行桌面 App 的这台机器**上，与远程网关无关。/ The plugin lives on the machine running the desktop app, regardless of where the gateway runs.

## 使用 Usage

`Cmd/Ctrl+K` 命令面板 / command palette:

- **切换 Enter 键位重映射** — 临时开 / 关，重启后保持 / Toggle on/off; the choice persists across restarts
- **诊断 Enter 键位重映射** — 升级 App 后键位失效时排查 / Diagnose capture after an app update

## 排错 Troubleshooting

- 三个键都变成换行、消息发不出去 → 有第二个键位处理器：Settings → Plugins 里禁用 enter-swap 类插件。/ All keys become newlines and nothing sends: another key-remap plugin is installed — disable it in Settings → Plugins.
- 「没找到输入框编辑器」→ App 升级改了内部结构，插件已自动退化成原版键位；报 issue 附上提示原文。/ Editor not found: an app update changed internal slot names; the plugin fell back to stock keys — open an issue with the exact message.

## 说明 Notes

Hack 而非官方能力，官方支持改键后可删除本插件（[上游请求 #49422](https://github.com/NousResearch/hermes-agent/issues/49422)）。思路来自 [fleps/hermes-desktop-enter-swap-plugin](https://github.com/fleps/hermes-desktop-enter-swap-plugin)。

A hack, not an official capability — remove it once core ships rebinding ([upstream #49422](https://github.com/NousResearch/hermes-agent/issues/49422)). Approach derived from [fleps/hermes-desktop-enter-swap-plugin](https://github.com/fleps/hermes-desktop-enter-swap-plugin).

## 卸载 Uninstall

Settings → Plugins 里禁用，或删掉插件文件夹。/ Disable it in Settings → Plugins, or delete the plugin folder.

## License

[MIT](LICENSE)
