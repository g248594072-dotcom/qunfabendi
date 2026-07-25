# Facebook 公共主页网页群发（本地版）

从 **SaleSmartly** 拉取「客户名 + 公共主页」，再用 **Playwright** 打开 Meta 业务套件收件箱发送（文字 + 可选图片）。

> 发送走的是网页收件箱自动化，不是 Graph 官方发信 API。存在改版失效与账号风控风险，请先小流量测试。

## 本地准备

1. 安装依赖

   ```bash
   npm install
   ```

   本机若已安装 Google Chrome，程序会优先用它。若没有 Chrome，再执行：

   ```bash
   npx playwright install chromium
   ```

2. 复制配置（只需填 SaleSmartly 密钥）

   ```bash
   copy .env.example .env
   ```

   编辑 `.env`：填入 `SALESMARTLY_PROJECT_ID`、`SALESMARTLY_API_TOKEN`。

## 推荐：可视化控制台

双击 `启动控制台.bat`，或：

```bash
npm run ui
```

浏览器打开：<http://127.0.0.1:3789>

### 推荐操作顺序

1. **① 登录 Facebook**（弹出浏览器后登录，再点「确认已登录」）
2. **② 同步 Sale 主页**
3. **探测 Facebook 可管理主页**（打开企业资产列表后点「确认」）
4. **勾选左侧「可管且已接入」的主页** → 保存设置
5. **③ 更新黑名单**（只拉勾选主页下带这些标签的客户）
   - `黑粉（澳）` / `定金客户（尾款补齐发货）` / `全款客户` / `分期客户` / `删`
   - 键：`page_id + 客户名`，写入 `data/blacklist.json`
6. **④ 同步发送客户**（只拉勾选主页，合并进本地库）
7. **⑤ 只定位** → **⑥ 真正发送**（自动排除黑名单）

### 「每页最多发送」是什么？

- 填 `2`：每个主页这次只发前 2 人（调试）
- 填 `0`：不限制（正式）

## 目录说明

| 路径 | 作用 |
| --- | --- |
| `src/salesmartly/` | SaleSmartly 签名与拉数 |
| `src/facebook/` | 登录态、探测、收件箱搜索与发送 |
| `data/pages.json` | 主页映射 |
| `data/contacts.json` | 待发客户 |
| `data/blacklist.json` | 黑名单 |
| `data/send-results.jsonl` | 发送日志 |
| `storage/browser-profile/` | Playwright 持久登录态（勿提交 Git） |

## 发送逻辑（简要）

1. 打开 `business.facebook.com/latest/inbox/all/?page_id=...`
2. 搜索客户名 → 进入会话
3. 输入文字，可选上传图片 → 发送
4. 随机等待 `SEND_DELAY_MIN`～`SEND_DELAY_MAX` 秒
5. 多个主页并行（同一账号多个标签页）

## 后续上服务器

本地跑通后，把项目拷到云服务器：

1. 同样 `npm install` + `playwright install chromium`
2. 首次仍需 `npm run login`（或把本机 `storage/browser-profile` 拷过去，注意安全）
3. 服务器可设 `HEADLESS=true`
4. 正式量把 `MAX_SEND_PER_PAGE=0`（不限制）

## 常见问题

- **搜索不到人**：SaleSmartly 里的 `name` 可能和 Facebook 显示名不一致；先看 `send-results.jsonl` 失败原因。
- **登录过期**：重新 `npm run login`。
- **页面结构变了**：收件箱改版会导致选择器失效，需要再改 `src/facebook/sender.ts`。
