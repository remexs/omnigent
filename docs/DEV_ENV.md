# 开发环境设置（Windows + WSL）

## 浏览器 CDP 测试（agent-browser）

- **CDP 端口**: 9223（**9222 被其他应用占用，勿用**）
- **浏览器 profile**: `D:\omnigent-cdp-profile`（**D 盘，非 C 盘**）
- **启动命令**:
  ```
  "C:\Program Files\Google\Chrome\Application\chrome.exe" \
    --remote-debugging-port=9223 \
    --user-data-dir=D:\omnigent-cdp-profile \
    --no-first-run http://localhost:6767
  ```
- **agent-browser 连接**: `agent-browser connect 9223`
- **登录**: admin / 123456

## 端口约定
- **6767**: omnigent server（WSL 容器，Windows 侧 localhost 直通）
- **9222**: 其他应用占用（勿用于测试）
- **9223**: 测试 Chrome CDP

## 容器环境
- server: omnigent-server（挂载 /build 热更新）
- DB: weclaw（postgres / omnigent）
- hosts: admin/zhangsan/wangwu/zhaoliu/lisi（共享 volume omnigent-shared → /workspace）
- 密码: 所有用户 123456
