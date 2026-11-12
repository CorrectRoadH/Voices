# 主题状态与生命周期

复用 CSS 语义变量与根元素 `.dark`。React 主题状态监听系统及存储事件，卸载时解除监听；head 中的同步初始化负责首屏配色。

浏览器偏好只接受 `system`、`light`、`dark`，未知值回退到 `system`。主题不写入账号或服务器，存储不可用不阻断当前页面切换。

验收通过[切换主题](use-case/change-theme.md)检查首屏、系统变化、标签页同步与监听释放。

## 官方组件与主题

界面统一使用 shadcn/ui 的 Base UI / nova 官方 neutral 预设（`b2fA`）。主题变量、圆角、控件 variants 来自 CLI，不维护第二套配色、控件尺寸或组件皮肤。中文字体回退与可访问文案本地化可保留。

应用壳使用 SidebarProvider、Sidebar、SidebarInset 与 SidebarTrigger；手机由官方 Sheet 展开导航，导航完成关闭。录音行使用 Item，上传入口使用 Empty 与 Button，折叠区域使用 Collapsible，人物使用 Avatar，转写消息使用 Message 与 Bubble，日期使用 Marker。设置、认证、诊断页沿用官方 Card、Field、Input、Badge、Alert、Tabs 与菜单组合。异步按钮通过 Button 的 disabled、aria-busy 与 Spinner 组合，不扩展基础 Button API。

业务组件继续负责录音上传、筛选、草稿、权限与真实异步状态。正文定位、分页、选择和播放器生命周期保留既有契约；CSS 仅保留这些业务所需的布局、滚动、定位和选择规则，不覆盖官方组件内部皮肤。上下文菜单使用官方 ContextMenu，不自行处理长按定时器。

验收覆盖桌面与 375px 的浅深主题、官方移动导航、录音搜索和导入、消息选择与菜单、编辑焦点、播放器、设置和管理页面。沿用正式入口的浏览器用例，并目视截图；删除旧皮肤与检查官方组件使用情况是迁移验收的一部分。

列表不外包 Card；使用 ItemGroup、Item 和 ItemSeparator 组织录音、任务与调用记录。登录页用视口居中布局。管理导航分组只调整入口组织，不变更路由与权限；侧栏账号按钮通过官方 DropdownMenu 提供账号与退出入口。日期输入组合官方 Calendar、Popover 与 InputGroup，跨入口共享本地日期值适配；动态提醒由统一 Toast 入口按类型与内容复用通知，页面不重复错误皮肤。
