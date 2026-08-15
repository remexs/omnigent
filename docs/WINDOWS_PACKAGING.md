# Windows 桌面端打包规则

> 打包及缓存规则固化，**禁止打包写到 C 盘**。

## 一键打包

```bat
web\electron\build-win.bat
```

双击运行 = 前端构建（vite）+ electron-builder 打包（NSIS），一次完成。

## 缓存规则（全部在 D 盘）

| 环境变量 | 值 | 用途 | 已固化 |
|---|---|---|---|
| `ELECTRON_BUILDER_CACHE` | `D:\electron-cache` | electron-builder 工具缓存（winCodeSign/nsis/electron） | ✅ 用户级环境变量（永久） |
| `ELECTRON_CACHE` | `D:\electron-cache` | @electron/get 下载缓存 | ✅ 用户级环境变量（永久） |
| `TMP` / `TEMP` | `D:\electron-cache\tmp` | 打包临时文件 | 仅在 build-win.bat 内设置（不污染系统 TMP） |

`D:\electron-cache` 结构：
```
7zip@1.0.0\        ← 解压工具
downloads\         ← @electron/get 下载
electron-v42.7.0-win32-x64.zip ← electron 本体
nsis-3.0.4.1\      ← NSIS
nsis-resources-3.4.1\
tmp\               ← 打包临时
winCodeSign\       ← 代码签名工具
winCodeSign-2.6.0\
```

## 两个打包流程（别混淆）

| | 前端打包（服务器 web-ui） | 桌面端打包（安装包） |
|---|---|---|
| 工具 | vite | electron-builder |
| 输出 | `omnigent/server/static/web-ui/`（25MB） | `web/electron/dist/`（462MB） |
| 产物 | 服务器 web 静态文件（docker 部署） | `Omnigent Setup 0.9.1.exe`（Windows 安装） |
| 命令 | `cd web && node node_modules\vite\bin\vite.js build` | `cd web\electron && npx electron-builder --win nsis` |

## 可删目录

- `D:\electron-dist`（解压的 electron 运行时副本）——**已删除**，可重建
- `web/electron/dist/win-unpacked`（361MB，解压产物）——可删，build-win.bat 重建
- `web/electron/dist/Omnigent Setup 0.9.1.exe`（104MB 安装包）——可删但需重打包才有

## 常见坑

1. **winCodeSign 下载失败**（网络 TLS）：electron-builder 打包 win32 需下载 winCodeSign。命中 `D:\electron-cache\winCodeSign-2.6.0\` 缓存即跳过。若缓存损坏（7z 只有几百字节），删掉该目录重新打包让 electron-builder 重新获取，或从能访问 github 的机器复制官方 `winCodeSign-2.6.0.7z`（sha512=`cdaec715...`）。
2. **打包卡死/锁占用**：残留 node 进程会锁住 dist——先 `taskkill /F /IM node.exe` + 删除 dist 下 `.lock` 再打包。
3. **C 盘缓存残留**：打包后检查 `C:\Users\<user>\AppData\Local\electron*`——若有内容，说明环境变量未生效（新终端生效，旧终端需重开）。
