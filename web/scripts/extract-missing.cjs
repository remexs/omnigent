const ts = require("typescript");
const fs = require("fs");
const path = require("path");

const dictSrc = fs.readFileSync("src/i18n/zh-CN.ts", "utf8");
const sf = ts.createSourceFile("z", dictSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const dict = new Set();
function w(n) {
  if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name)) dict.add(n.name.text);
  ts.forEachChild(n, w);
}
w(sf);

const missing = new Set();
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p);
    } else if (/\.tsx$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
      const src = fs.readFileSync(p, "utf8");
      const sf2 = ts.createSourceFile(p, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      function w2(n) {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "L") {
          for (const a of n.arguments) {
            if (ts.isStringLiteral(a) && !dict.has(a.text)) missing.add(a.text);
          }
        }
        ts.forEachChild(n, w2);
      }
      w2(sf2);
    }
  }
}
walk("src");

const KEEP = new Set([
  "/Users/you/projects/app", "/path/to/repo", "% of context used.",
  "alice@example.com", "claude-sonnet-4-20250514", "codex login",
  "cursor-agent login", "omni setup", "omnigent server --agent",
  "feature/my-branch", "my-agent", "daily-brief", "server-name",
  "e.g. **/node_modules, *.test.ts", "e.g. *.ts, src/**", "e.g. main",
  "args (e.g. -y @modelcontextprotocol/server-github)",
  "command (e.g. npx)", "Header-Name", "In [", "· attempt", "— run",
  "You are a helpful assistant that...", "xHigh", "Yolo",
  "OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD", "Databricks Lakebox",
]);

const T = {
  "On a fresh install you set the first admin's password yourself — no credential is\nauto-generated. A brand-new instance shows a Create-admin form instead of this one; the\npassword can also be pre-seeded with": "全新安装时，您自己设置第一位管理员的密码 — 不会自动生成凭据。全新的实例会显示创建管理员表单，而不是此页面；密码也可以通过以下方式预置：",
  "A single-use invite URL will be created. Share it with the person you want to add.": "将创建一个一次性的邀请链接。请与您要添加的人员分享。",
  "This deletes the user account and revokes all their session permissions. Sessions they\nowner are kept but become unshareable, and their comments remain.": "这将删除用户账号并撤销其所有会话权限。他们拥有的会话会保留但无法分享，其评论也会保留。",
  "This removes the global policy from all sessions. Existing session-level policies with\nthe same handler are not affected.": "这将从所有会话中移除全局策略。具有相同处理器的现有会话级策略不受影响。",
  "For security, a custom path can only be set from the connect screen — this prevents a\ncompromised web session from redirecting a local CLI install.": "出于安全考虑，自定义路径只能从连接页面设置 — 这可以防止被入侵的网页会话重定向本地 CLI 安装。",
  "Control whether users on this server can share sessions with others. Applies server-wide\nand to every session.": "控制此服务器上的用户是否可以与他人分享会话。适用于整个服务器及每个会话。",
  "Allow sharing a session with anyone who has the link (public read access). When\nsharing is on, session owners can also share with specific people.": "允许与拥有链接的任何人分享会话（公开只读访问）。分享开启后，会话所有者也可以与特定人员分享。",
  "This directory differs from the original session's. Earlier file\nreferences in the conversation may not resolve here.": "此目录与原会话不同。会话中较早的文件引用可能无法在此处解析。",
  "Danger: this session runs Codex with approvals and the sandbox disabled. It can\nedit any file and run any command without asking.": "危险：此会话以关闭审批和沙箱的方式运行 Codex。它可以不经询问编辑任何文件并运行任何命令。",
  "Cloned into the sandbox as the session's working directory. Leave blank to\nuse the sandbox default.": "克隆到沙箱中作为会话的工作目录。留空则使用沙箱默认值。",
  "New branch name, or pick an existing worktree. Leave blank to start directly\nin the workspace.": "新分支名称，或选择现有 worktree。留空则直接在工作区中开始。",
  "Codex will run with approvals and the sandbox disabled — it can edit any file and\nrun any command without asking. Use only with trusted conversations.": "Codex 将以关闭审批和沙箱的方式运行 — 它可以不经询问编辑任何文件并运行任何命令。仅在与可信的会话中使用。",
  "Couldn't load this project's settings. Close and reopen to try again — saving is\ndisabled until they load.": "无法加载此项目的设置。关闭并重新打开以重试 — 在加载完成前保存已禁用。",
  "This clone hasn't picked a working directory yet. Choose a host and directory to\ncontinue.": "此克隆尚未选择工作目录。请选择主机和目录以继续。",
  "The original session's host is offline, so there's nothing to launch a runner on.\nReconnect the host or pick a different one.": "原会话的主机已离线，因此没有可启动 runner 的目标。请重新连接主机或选择其他主机。",
  "working in this directory. Write operations may conflict. Name a git branch to\nwork in an isolated copy.": "在此目录中工作。写入操作可能冲突。命名一个 git 分支以在隔离副本中工作。",
  "This directory differs from the original session's. Earlier file references in\nthe conversation may not resolve here.": "此目录与原会话不同。会话中较早的文件引用可能无法在此处解析。",
  "Creates a git worktree for a new branch in an isolated directory — keeps the clone\nfrom affecting the original session's working tree.": "在隔离目录中为新分支创建 git worktree — 防止克隆影响原会话的工作树。",
  "Continue this session on a different agent. The conversation, comments, and files stay;\nthe new agent starts fresh from here.": "在其他智能体上继续此会话。会话、评论和文件会保留；新智能体将从此处全新开始。",
  "This file is too large to load fully — showing a truncated preview. Editing is disabled to\navoid accidental corruption.": "此文件太大无法完整加载 — 正在显示截断预览。为避免意外损坏，编辑已禁用。",
  "session(s)": "会话",
  "You are a helpful assistant that...": "你是一个乐于助人的助手……",
  "Save": "保存",
  "Cancel": "取消",
  "Close": "关闭",
  "Delete": "删除",
  "Edit": "编辑",
  "Copy": "复制",
  "Add": "添加",
  "Create": "创建",
  "Remove": "移除",
  "Share": "分享",
  "Download": "下载",
  "Upload": "上传",
  "Refresh": "刷新",
  "Retry": "重试",
  "Settings": "设置",
  "Help": "帮助",
  "Done": "完成",
  "Back": "返回",
  "Next": "下一步",
  "Confirm": "确认",
  "Submit": "提交",
  "Send": "发送",
  "Stop": "停止",
  "Run": "运行",
  "Start": "开始",
  "Finish": "完成",
  "Update": "更新",
  "Open": "打开",
  "View": "查看",
  "Show": "显示",
  "Hide": "隐藏",
  "More": "更多",
  "Name": "名称",
  "Status": "状态",
  "Type": "类型",
  "Model": "模型",
  "Agent": "智能体",
  "Session": "会话",
  "Message": "消息",
  "File": "文件",
  "Folder": "文件夹",
  "Project": "项目",
  "Host": "主机",
  "Server": "服务器",
  "Terminal": "终端",
  "Shell": "Shell",
  "Tool": "工具",
  "Policy": "策略",
  "Permission": "权限",
  "Member": "成员",
  "Admin": "管理员",
  "Owner": "所有者",
  "Account": "账号",
  "Language": "语言",
  "Theme": "主题",
  "General": "通用",
  "Advanced": "高级",
  "Custom": "自定义",
  "Default": "默认",
  "System": "系统",
  "Light": "浅色",
  "Dark": "深色",
  "High": "高",
  "Medium": "中",
  "Low": "低",
  "Auto": "自动",
  "Manual": "手动",
  "Normal": "标准",
  "Active": "进行中",
  "Paused": "已暂停",
  "Pause": "暂停",
  "Resume": "恢复",
  "Completed": "已完成",
  "Failed": "失败",
  "Success": "成功",
  "Error": "错误",
  "Warning": "警告",
  "Loading": "加载中",
  "Saving": "保存中",
  "Connecting": "连接中",
  "Connected": "已连接",
  "Disconnected": "已断开",
  "Offline": "离线",
  "Online": "在线",
  "Pending": "待处理",
  "Approved": "已批准",
  "Rejected": "已拒绝",
  "Allow": "允许",
  "Deny": "拒绝",
  "Approve": "批准",
  "Reject": "拒绝",
  "Install": "安装",
  "Uninstall": "卸载",
  "Export": "导出",
  "Import": "导入",
  "Invite": "邀请",
  "Leave": "离开",
  "Join": "加入",
  "Details": "详情",
  "Expand": "展开",
  "Collapse": "折叠",
  "Pin": "置顶",
  "Unpin": "取消置顶",
  "Archive": "归档",
  "Unarchive": "取消归档",
  "Rename": "重命名",
  "Duplicate": "复制",
  "Public": "公开",
  "Private": "私有",
  "Read": "只读",
  "Write": "写入",
  "Manage": "管理",
  "Select": "选择",
  "New": "新建",
  "Continue": "继续",
  "Reset": "重置",
  "Clear": "清除",
  "Search": "搜索",
  "Filter": "筛选",
  "Sort": "排序",
  "Enable": "启用",
  "Disable": "禁用",
  "On": "开",
  "Off": "关",
  "Yes": "是",
  "No": "否",
  "OK": "确定",
  "All": "全部",
  "None": "无",
  "Any": "任意",
  "Other": "其他",
  "Unknown": "未知",
  "Recent": "最近",
  "Today": "今天",
  "Yesterday": "昨天",
  "Time": "时间",
  "Date": "日期",
  "Size": "大小",
};

const entries = [];
for (const k of missing) {
  if (KEEP.has(k)) continue;
  if (T[k] !== undefined) entries.push([k, T[k]]);
}
console.log("待添加:", entries.length, "保留英文:", [...missing].filter((k) => KEEP.has(k)).length);
console.log("未处理:", [...missing].filter((k) => !KEEP.has(k) && T[k] === undefined));
fs.writeFileSync("/tmp/missing-final.json", JSON.stringify(entries));
