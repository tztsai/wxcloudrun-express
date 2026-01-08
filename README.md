# Ruminer WeChat Service (微信云托管 Express.js)

Ruminer WeChat Service 在微信云托管（CloudBase）上的 Node.js Express 容器部署。

功能：
- 验证微信服务号回调签名
- 接收微信 XML 消息（文本指令与文章链接）
- 抓取微信公众号文章 HTML 并转换为 Markdown
- 加密存储用户 GitHub 凭据（openid → token/repo/path）
- 通过 GitHub Contents API 将 Markdown 提交到用户指定的仓库

## 部署路由

| 方法 | 路由            | 说明                                      |
| ---- | --------------- | ----------------------------------------- |
| GET  | `/api/healthz`  | 健康检查，返回 `{ status: "ok" }`         |
| GET  | `/api/callback` | 微信服务器校验（signature check）         |
| POST | `/api/callback` | 接收微信 XML 消息并处理（绑定、保存文章） |

## 环境变量配置

### 必需
- `WECHAT_TOKEN`：微信服务号回调 token（用于签名校验）
- `TOKEN_ENCRYPTION_KEY_BASE64`：32 字节密钥的 Base64 编码（用于加密 GitHub token 存储）
- `MYSQL_ADDRESS`：MySQL 连接地址（格式：`host:port`，如 `127.0.0.1:3306`）
- `MYSQL_USERNAME`：MySQL 用户名
- `MYSQL_PASSWORD`：MySQL 密码

### 可选
- `WECHAT_APP_ID`、`WECHAT_AES_KEY`：用于消息加密模式（safe mode）
- `WECHAT_APP_SECRET`：用于调用微信 API（客服消息异步通知）
- `WECHAT_REPLAY_PROTECT`：是否启用重放攻击防护（默认 true）
- `WECHAT_TIMESTAMP_TOLERANCE_SECONDS`：时间戳容差（默认 600）
- `GITHUB_DEFAULT_BRANCH`：GitHub 默认分支（默认 `main`）
- `GITHUB_VERIFY_ON_BIND`：绑定时是否验证 GitHub repo 可访问（默认 true）

## 本地开发 / 调试

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
创建 `.env.local` 或通过系统环境变量设置上述必需/可选变量。

### 3. 启动应用
```bash
npm start
```

应用将在 `http://localhost:80` 启动（或 `$PORT` 指定的端口）。

## 云托管部署

### 1. 创建服务
在微信云托管控制台创建新服务，选择"自定义代码"或对接 GitHub/GitLab 仓库。

### 2. 配置环境变量
在「服务设置」→「环境变量」中添加所有必需变量，例如：
```
WECHAT_TOKEN = your_token_here
TOKEN_ENCRYPTION_KEY_BASE64 = <base64-encoded-32-byte-key>
MYSQL_ADDRESS = your-mysql-host:3306
MYSQL_USERNAME = root
MYSQL_PASSWORD = your_password
```

### 3. 部署
推送到关联的代码仓库或通过控制台直接部署此目录。

### 4. 配置微信后台
在微信公众号管理后台"开发"→"基本配置"中，设置回调 URL：
```
https://<你的云托管公网域名>/api/callback
```
并填写对应的 Token（必须与 `WECHAT_TOKEN` 一致）。

## 快速验证

### 健康检查
```bash
curl https://<cloud-domain>/api/healthz
# 返回: {"status":"ok"}
```

### 小程序联调示例
在小程序代码中调用：
```js
wx.cloud.callContainer({
  config: {
    env: "prod-2gkwjnxqc77c907f"  // 替换为你的 CloudBase 环境 ID
  },
  path: "/api/healthz",  // 或 "/api/callback" 用于微信回调验证
  header: {
    "X-WX-SERVICE": "express-s5cz"  // 替换为你的服务名
  },
  method: "GET",
  data: {}
})
.then(res => {
  console.log(res)
})
.catch(err => {
  console.error(err)
})
```

## 项目结构

```
.
├── Dockerfile
├── README.md
├── index.js                          # Express 应用入口
├── db.js                             # Sequelize ORM + 数据模型
├── index.html                        # 静态首页（可选）
├── package.json
├── ruminer/
│   ├── lib/                          # Ruminer 核心库（文章抓取、加密、微信 API 等）
│   ├── kvAdapter.js                  # MySQL → Workers KV 兼容适配器
│   └── wechatRoutes.js               # 微信回调路由处理
└── container.config.json             # 云托管初始配置（部署后可忽略）
```

## 数据库

应用使用 Sequelize ORM，自动建表：
- `rumi_kv`：用户绑定、幂等状态、重放防护数据（支持 TTL 过期）

如需 MySQL 连接遇到问题，检查：
1. `MYSQL_ADDRESS` 格式是否正确（含端口）
2. 云托管与 MySQL 数据库是否在同一 VPC
3. 防火墙/安全组规则是否允许 MySQL 连接

## 日志

应用输出 JSON 格式日志，包含 `request_id` 用于追踪。敏感信息（token、openid）会被脱敏。

在云托管控制台「日志」标签页可查看实时应用日志。

## 参考文档

- [Ruminer 规格文档](../docs/spec/)
- [微信云托管官方文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloudrun/)
- [Express.js 文档](https://expressjs.com/)

## License

本项目由 Ruminer 项目与微信云托管 Express 模板结合而成。
