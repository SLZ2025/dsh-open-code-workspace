# dsh-open-code-workspace

在 **DeepSeek Harness** 侧栏中打开 VS Code 的 `.code-workspace` 文件，把文件里列出的
多个目录当成**一个多根工作区**——相当于 VS Code 的「文件 → 从文件打开工作区」。

## 它做了什么

侧栏 **工作区** 标题右侧、放大镜左边会多出一个小文件夹图标。点击后：

1. 弹出系统文件对话框，只显示 `*.code-workspace`；
2. 读取文件里的 `folders`（支持注释和尾随逗号）；
3. 把这些目录变成一个目录下的 **junction**（Windows）或**软链接**（macOS/Linux）；
4. 把这个聚合目录注册为 DeepSeek Harness 的一个工作区，并在其中新开一个空会话。

因为条目都是链接，所有编辑仍然落在真实仓库里，不会复制文件，也不会执行工作区文件里的任何内容。

## 环境要求

* 带 Web 界面（含桌面版）的 DeepSeek Harness，并且能用 `plugin_manager` 安装 bundle。
* 系统对话框：Windows 用 PowerShell，macOS 用 `osascript`，Linux 用 `zenity` 或 `kdialog`。

## 安装

已发布到 npm：`dsh-open-code-workspace`。在 **插件** 页面安装，或把包名交给安装器
（`dsh-open-code-workspace@0.1.0`）。它的 patch 只插入一行：

```yaml
- insert:
    - id: dsh-open-code-workspace
      name: dsh-open-code-workspace
```

本地开发时把安装目标指向本目录（`install_bundle` 的绝对路径），不要直接写包名。
Host 部分会立即生效；**刷新一次网页**让客户端部分加载。

## 使用

1. 安装后刷新页面。
2. 在侧栏找到 **工作区**，点标题和放大镜之间的文件夹图标。
3. 选择 `.code-workspace` 文件（例如 `C:\projects\acme.code-workspace`）。
4. 工作区列表里会出现聚合后的一个工作区，并新开一个会话。

搜索框展开时按钮会隐藏，不会遮住原生控件。

## 聚合目录放在哪里

```
$DSH_HOME/multiroot/<文件标题>-<目录列表哈希>/
    frontend  -> C:\projects\web-app   （junction / 软链接）
    backend   -> C:\projects\api
```

可以用 `DSH_OPEN_CODE_WORKSPACE_ROOT` 改根目录。修改工作区文件里的目录列表后会生成
新的聚合目录（哈希在名字里），旧目录不会混入过期目录；不需要时直接删掉
`$DSH_HOME/multiroot` 即可。

## 实现说明

见 [`docs/DETAIL.md`](docs/DETAIL.md)：为什么用 `shell.overlay`、两个 Host 路由的分工、
以及安全边界。简述：客户端只负责在 `[data-sidebar-workspace-header]` 旁绘制按钮，
Host 端负责系统对话框和 junction 聚合——浏览器两样都做不到，而 `resource` 路由只响应
`GET`/`HEAD`。两个 Host 路由都会先调用 `ctx.connection.authorizeIndex`，只接受 DSH
页面已认证的浏览器会话，其他来源一律返回 `401`。

## 常见问题

* **看不到按钮** —— 刷新页面；收起搜索框；把侧栏拉宽，让标题栏的操作区露出来。
* **`打开失败：picker-unavailable`** —— Linux 装 `zenity`/`kdialog`，或检查对应平台的对话框命令。
* **`farm-failed` / `EPERM`** —— 所在磁盘不允许创建 reparse point / 符号链接。

## 开发

```bash
node --check index.js
node --check client.js
node test/smoke.mjs
```

smoke 测试用桩 Cordis 上下文驱动两个 Host 路由，并在临时目录里真实创建 junction。

## 许可证

MIT
