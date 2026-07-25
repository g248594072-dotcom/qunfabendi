# Facebook 公共主页网页群发

从 **SaleSmartly** 拉取「客户名 + 公共主页」，再用 **Playwright** 打开 Meta 业务套件收件箱发送（文字 + 可选图片）。

> 发送走的是网页收件箱自动化，不是 Graph 官方发信 API。存在改版失效与账号风控风险，请先小流量测试。

---

## 服务器部署（推荐 Docker + Nginx）

当前示例服务器：`http://107.175.246.246/`（已有 nginx；应用经反代挂到 80 端口）。

适合：控制台跑在云上，每账号独立代理 IP；登录交给他人（noVNC 远程操作，或上传资料包）。

### 1. 准备

- Ubuntu + [Docker](https://docs.docker.com/engine/install/) + Compose
- 已有 nginx（你的机器根路径若是 404，正适合挂我们的站点）
- 安全组/防火墙放行：`80`（必开）、`443`（上 HTTPS 时）

### 2. 上传项目并配置

```bash
cd /path/to/网页群发
cp deploy/server.env.example .env
nano .env   # 填 SaleSmartly 密钥、UI_PASSWORD
```

`.env` 关键项（IP 已写好）：

```env
UI_HOST=0.0.0.0
SERVER_MODE=1
UI_USER=admin
UI_PASSWORD=改成强密码
NOVNC_URL=http://107.175.246.246/novnc/vnc.html?autoconnect=1&resize=remote&path=websockify
```

### 3. 一键启动（Docker + 写入 nginx）

```bash
bash deploy/apply-on-server.sh
docker compose logs -f
```

访问（走 80，不必再记 3789）：

| 地址 | 用途 |
| --- | --- |
| http://107.175.246.246/ | 主控制台 |
| http://107.175.246.246/login.html | 登录助手（交给他人） |
| http://107.175.246.246/novnc/vnc.html?autoconnect=1&resize=remote&path=websockify | 远程浏览器 |

浏览器会弹出 Basic 认证，账号密码即 `UI_USER` / `UI_PASSWORD`。

### 绑定你的域名

1. DNS：A 记录指向 `107.175.246.246`
2. 改 nginx：`server_name 你的域名;`（可参考 `deploy/nginx-fb-domain.conf.example`）
3. 改 `.env` 里 `NOVNC_URL` 为 `http://你的域名/novnc/...`
4. `nginx -t && systemctl reload nginx`
5. （可选 HTTPS）`certbot --nginx -d 你的域名`

### 4. 服务器上的推荐流程

1. 主控制台：**添加账号** → 每个号点「代理IP」填 SOCKS5（协议/域名/端口/账号/密码）
2. 把 `login.html` 链接发给登录的人
3. 对方打开 **登录助手** → **打开远程浏览器** → 对某个号点「打开登录」→ 在 noVNC 里完成 Facebook 登录 → 回助手点「确认已登录」
4. 主控制台勾选「无头模式」并保存 → 同步主页 / 探测 / 黑名单 / 客户 → 发送

### 5. 没有 noVNC 时：资料包交接

若不想开 6080，可在有桌面的电脑登录后：

1. 本机控制台对该账号「导出资料」得到 `.tar.gz`
2. 服务器登录助手对该账号「上传资料包」

注意：资料包含 Facebook 登录态，按密钥保管；尽量在**相同代理 IP** 下登录再上传，降低风控。

### 一键更新（以后改代码后）

本机改完并 push 到 GitHub 后，在**服务器项目目录**执行：

```bash
./update.sh
```

等价于：`git pull` → `docker compose up -d --build` → 重载 nginx。

首次部署若还没有仓库：

```bash
git clone https://github.com/g248594072-dotcom/qunfabendi.git
cd qunfabendi
cp deploy/server.env.example .env
nano .env
bash deploy/apply-on-server.sh
```

### 常用命令

```bash
./update.sh                 # 一键更新
docker compose ps
docker compose logs -f app
docker compose restart
docker compose down
```

数据持久化在宿主机目录：`./data`、`./storage`（更新代码不会清空）。

---

## 裸机安装（systemd，无 Docker）

```bash
sudo bash deploy/install-ubuntu.sh
# 编辑 /opt/fb-broadcast/.env
sudo systemctl start fb-broadcast
```

裸机默认**没有**图形界面：发送请勾选无头模式；登录请用「上传资料包」，或自行给机器装桌面/VNC。需要远程看浏览器时请用上面的 Docker 方案。

---

## 本地调试

```bash
npm install
npx playwright install chromium   # 若无本机 Chrome
copy .env.example .env            # Windows；Linux 用 cp
npm run ui
```

浏览器打开：<http://127.0.0.1:3789>

本地可把 `UI_HOST` 保持 `127.0.0.1`，不必设密码。

### 推荐操作顺序

1. **添加 Facebook 账号**，并为每个账号设置独立代理 IP  
2. **登录**（本机弹窗 / 登录助手 / 服务器 noVNC / 资料包）  
3. **② 同步 Sale 主页** → **探测可管理主页** → 勾选并保存  
4. **③ 更新黑名单** → **④ 同步发送客户**  
5. **⑤ 只定位** → **⑥ 真正发送**（服务器请勾选无头模式）

### 「每页最多发送」

- `2`：每页只发前 2 人（调试）  
- `0`：不限制（正式）

---

## 目录说明

| 路径 | 作用 |
| --- | --- |
| `src/` | 服务端逻辑 |
| `public/` | 控制台与登录助手 |
| `data/` | 账号、主页、客户、黑名单等 JSON |
| `storage/profiles/` | 各账号 Playwright 登录态 |
| `deploy/` | 安装脚本与 systemd |
| `docker-compose.yml` | 一键服务器部署 |

## 常见问题

- **公网能打开但很危险**：务必设置 `UI_PASSWORD`；有条件再加 Nginx + HTTPS。  
- **点了打开登录但看不到浏览器**：检查 `6080` 端口与 `NOVNC_URL` 是否指向正确 IP。  
- **搜索不到人**：Sale 里的名字可能与 Facebook 显示名不一致。  
- **登录过期**：重新走登录助手，或重新上传资料包。  
- **页面结构变了**：需改 `src/facebook/sender.ts`。
