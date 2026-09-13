# RustDesk Admin

<p align="center">
  [<a href="../README.md">English</a>] | [<a href="README-RU.md">Русский</a>] | [<a href="README-AR.md">العربية</a>]<br>
</p>

一个单体仓库，用于部署完全容器化的 **RustDesk 服务器**并附带 Web 管理面板：
ID 服务器 + 中继服务器 + 管理面板 + 设备在线状态（live presence）+
自动签发 Let's Encrypt TLS —— 全部整合在一个 Docker Compose 项目中。

> 本项目完全由 AI 编码助手编写——仓库中没有任何手写代码。
宿主机只需 **Docker** —— 不需要 systemd 单元、宿主机 certbot 或宿主机 nginx。

所有操作都不会丢失状态：`docker compose restart`、重启服务器、再次运行
`./setup.sh` 都不会丢失数据和设置。

```
rustdesk-stack/
├── docker-compose.yml         # 8 个服务，同一网络
├── docker-compose.dev.yml     # 可选覆盖：air 热重载 + vite 开发服务器
├── setup.sh                   # 首次启动引导（幂等）
├── .env.example               # 模板；复制为 .env
├── Makefile                   # 常用命令（dev/build/logs/db ...）
├── backend/                   # Go 管理 API（编译为小巧的生产镜像）
├── frontend/                  # React 管理界面（静态 nginx / SPA）
├── nginx/nginx.conf.template  # ${DOMAIN} + ACME webroot + WSS 终结
├── presence/Dockerfile        # 在线状态轮询器（docker.sock + nsenter）
├── scripts/presence.sh        # 实时连接快照（hbbs/hbbr 命名空间）
├── data/                      # 实时数据 —— 由 setup.sh 创建：
│   ├── hbbs/                  #   hbbs/hbbr 密钥（id_ed25519）+ 设备数据库（sqlite）
│   ├── postgres/              #   Postgres 数据目录（绑定挂载）
│   └── certbot/etc/           #   Let's Encrypt live/archive/renewal
└── status/                    # presence.json（由 presence 容器写入）
```

`data/` 和 `status/` 已被 git/tar 忽略，永远不会打包进发行物。

## 截图

| 浅色主题                                                  | 深色主题                                                 |
|-----------------------------------------------------------|----------------------------------------------------------|
| ![仪表盘（浅色）](screenshots/Dashboard_white.png)         | ![仪表盘（深色）](screenshots/Dashboard_dark.png)         |

---

## 目录

- [功能](#功能)
- [架构 / 服务](#架构--服务)
- [前置要求](#前置要求)
- [全新安装](#全新安装)
- [端口与 `.env` 配置](#端口与-env-配置)
- [证书（Let's Encrypt）](#证书lets-encrypt)
- [服务器信息（Server Info）](#服务器信息server-info)
- [RustDesk Web 客户端](#rustdesk-web-客户端)
- [客户端配置代码](#客户端配置代码)
- [开发模式（dev overlay）](#开发模式dev-overlay)
- [下载源与镜像（Block C）](#下载源与镜像block-c)
- [构建后的 Docker 清理（Block D）](#构建后的-docker-清理block-d)
- [备份与迁移](#备份与迁移)
- [故障排查](#故障排查)
- [API（参考）](#api参考)

---

## 功能

- **Web 管理面板**（React SPA + Go API）：
  - 仪表盘 —— 服务器状态摘要、实时在线。
  - 设备 —— 已注册设备列表（`GET /api/devices`）、查看详情、删除。
  - 设置 —— 面板设置（初始从 `.env` 读取，之后以数据库为准）；会话时长也可在此配置。
  - 登录 = JWT access + refresh 令牌，会话保存在服务端；会话随 refresh 令牌过期而轮换和清理；可修改管理员凭据。
- **实时在线状态**（`presence` 容器）：
  - 直接从 hbbs/hbbr 的网络命名空间读取真实连接（nsenter + `ss` + docker.sock）；
  - 将活跃对端 IP、监听端口状态和对端→IP 绑定写入 `status/presence.json`；
  - 后端也会聚合状态，并通过 `/api/status` 暴露。
- **RustDesk 服务器**：官方镜像 `rustdesk/rustdesk-server:1.1.16` 中的 hbbs（ID）+
  hbbr（中继）；密钥与设备库存放在 `data/hbbs/`。
- **零配置 TLS**：自管理 Let's Encrypt（webroot），每 12 小时自动续期；
  另在端口 21118/21119 提供 nginx WSS 终结以支持 RustDesk TCP-mux。
- **带来源的 Server Info**：客户端/Web 客户端从 `GET /api/server-info` 读取
  地址/端口/密钥 —— 每个字段都会标明其来源（env/setting/stack）。
- **为 RustDesk Web 客户端开启 CORS**：响应头允许 rustdesk.com Web 客户端访问。

---

## 架构 / 服务

| 服务     | 镜像                                        | 用途                                                 |
|----------|---------------------------------------------|------------------------------------------------------|
| postgres | postgres:16-alpine                           | 面板数据库（`./data/postgres`），启动时自动迁移      |
| backend  | 自建（`backend/Dockerfile`，production 阶段） | REST API + WebSocket + presence 读取                 |
| frontend | 自建（`frontend/Dockerfile`，production 阶段） | 管理界面（静态 nginx / SPA）                         |
| nginx    | nginx:alpine                                 | HTTPS 面板、ACME webroot、WSS 21118/21119            |
| hbbs     | rustdesk/rustdesk-server:1.1.16              | ID 服务器（`-r ${DOMAIN}:21117`）                    |
| hbbr     | rustdesk/rustdesk-server:1.1.16              | 中继服务器                                           |
| presence | 自建（`presence/Dockerfile`）                 | 命名空间轮询 → `status/presence.json`                |
| certbot  | certbot/certbot                              | 首次签发，每 12 小时续期                             |

所有容器都使用 `restart: unless-stopped` —— 系统重启或 Docker 重启后会自动恢复。

---

## 前置要求

- Docker Engine + Docker Compose v2：
  ```
  apt update && apt install -y docker.io docker-compose-v2
  systemctl enable --now docker
  ```
- 一个指向本服务器的公网域名（DNS A 记录）。
- 空闲 TCP 端口：`80`、`443`、`21115`–`21119`（外加 UDP `21116`、`21117`）；
  全部可通过 `.env` 重新映射（见下文）。
- 默认 backend/frontend 镜像很小（约 50 MB / 几 MB）。
  dev overlay 需要数 GB 磁盘和约 2 GB 内存。
- 低配硬件建议（例如 1.9G 内存 / 8.7G 磁盘）：构建前先添加 swap 文件
  （构建会消耗内存），并留意磁盘剩余空间。

ufw 防火墙示例：

```
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 21115/tcp
ufw allow 21116/tcp
ufw allow 21116/udp
ufw allow 21117/tcp
ufw allow 21117/udp
ufw allow 21118/tcp
ufw allow 21119/tcp
ufw enable
```

---

## 全新安装

```
git clone https://github.com/pierce1stg/RustDeskAdmin.git
cd RustDeskAdmin

cp .env.example .env
# 编辑 .env：DOMAIN=<你的主机名>, LETSENCRYPT_EMAIL=<你的邮箱>
./setup.sh
```

运行前请确认 `DOMAIN` 已解析（A 记录）到本服务器的公网 IP，且端口 80 可从公网访问——
Let's Encrypt HTTP-01 挑战由 nginx 通过它提供。如果首次运行出现 **“placeholder cert”**
警告而其它一切正常，请修正 DNS/防火墙后重新运行 `./setup.sh`——脚本是幂等的，
会以同一域名重试签发。

### 手动生成密钥（可选）

`setup.sh` 会在空值/`changeme` 时自动生成密钥（见下文 Block A）。若想自行指定：

```
POSTGRES_PASSWORD=$(openssl rand -base64 32)
JWT_SECRET=$(openssl rand -base64 32)
JWT_REFRESH_SECRET=$(openssl rand -base64 32)
```

然后将值写入 `.env`。保留 `changeme` 也可以——脚本会在首次运行时替换为随机值。

`setup.sh`（幂等）将：

1. 如果 `POSTGRES_PASSWORD`、`JWT_SECRET`、`JWT_REFRESH_SECRET` 为空或为 `changeme`，
   则自动生成；
2. 创建 `data/` 和 `status/`；
3. 将自签名占位证书放入 `data/certbot/etc/live/<DOMAIN>`，确保 nginx 始终以 TLS 启动；
4. `docker compose up -d --build`；
5. 等待 hbbs 创建 `data/hbbs/db_v2.sqlite3`；
6. 通过端口 80 上的 HTTP-01 webroot 签发真实的 Let's Encrypt 证书
   （`--cert-name <DOMAIN>`）并立即重载 nginx；
7. 输出摘要。

随时可再次运行 `./setup.sh` 以（重新）构建、（重新）创建容器或（重新）签发证书。

### 首次登录

管理员凭据由 `.env` 的 Block B 提供（`ADMIN_USERNAME`/`ADMIN_PASSWORD`，
默认 `admin`/`admin`）。**请立即在面板中修改密码**（设置 → 管理员凭据）。
密码至少 8 个字符（由后端校验）。

---

## 端口与 `.env` 配置

### Block A（必填 / 机密）

| 变量                 | 说明                                             |
|----------------------|--------------------------------------------------|
| `DOMAIN`             | 公网主机名（DNS A → 本机）                       |
| `LETSENCRYPT_EMAIL`  | 用于 LE 通知的邮箱（续期）                        |
| `POSTGRES_PASSWORD`  | Postgres 密码（若为 `changeme` 则自动生成）       |
| `JWT_SECRET`         | API JWT 签名密钥（自动生成）                     |
| `JWT_REFRESH_SECRET` | refresh 令牌签名密钥（自动生成）                 |

### Block B（一次性种子 —— 之后设置由面板接管）

`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`STATUS_REFRESH_INTERVAL`（30s）、
`SERVER_DISPLAY_ADDRESS`（可选覆盖）、`RUSTDESK_PUBLIC_KEY`（可选；在新栈上
hbbs 会在 `data/hbbs` 生成密钥）、`RUSTDESK_ID_PORT`、`RUSTDESK_RELAY_PORT`、
`RUSTDESK_WS_PORT`、`ACCESS_TOKEN_TTL_MINUTES`（60）、`REFRESH_TOKEN_TTL_DAYS`（7）。

### 会话时长（JWT TTL）

access 令牌为每次 API 调用把关；refresh 令牌维持浏览器会话并在每次刷新时轮换。
两者均可配置 —— 在新栈上从 `.env` 种入，之后随时可在**设置 → 会话**中修改：

| 变量                       | 默认值 | 允许范围 | 说明                                  |
|----------------------------|--------|----------|---------------------------------------|
| `ACCESS_TOKEN_TTL_MINUTES` | 60     | 5..10080 | access 令牌有效期（分钟）             |
| `REFRESH_TOKEN_TTL_DAYS`   | 7      | 1..365   | 空闲会话保持存活的天数                |

会话存储在服务端的 `auth_sessions`（postgres），因此已登录状态能扛过后端重启和
重新部署。修改 TTL 只影响之后签发的令牌；已签发的令牌到期后自然失效，届时面板
只会要求重新登录。

### 主机端口映射（全部可选，显示默认值）

| 变量             | 默认值 | 说明                                   |
|------------------|--------|----------------------------------------|
| `HTTP_PORT`      | 80     | ACME webroot / HTTP→HTTPS              |
| `HTTPS_PORT`     | 443    | 面板 TLS                              |
| `NAT_PORT`       | 21115  | hbbs（NAT/心跳）                       |
| `ID_PORT`        | 21116  | hbbs ID 服务器（tcp+udp）              |
| `RELAY_PORT`     | 21117  | hbbr 中继（tcp+udp）                   |
| `WSS_ID_PORT`    | 21118  | WSS → hbbs（nginx TLS 终结）           |
| `WSS_RELAY_PORT` | 21119  | WSS → hbbr（nginx TLS 终结）           |
| `API_PORT`       | 8080   | 后端暴露到宿主的端口（调试用）          |

容器内的监听端口固定不变；只有主机端口映射可参数化。例如：如果其它服务占用了
宿主机 443 端口，可设置 `HTTPS_PORT=8443`。

---

## 证书（Let's Encrypt）

- 引导：自签名占位证书 → 栈始终以 TLS 启动。
- 签发：HTTP-01 webroot。需要宿主 80 端口（见 `HTTP_PORT`）以及入站 TCP/UDP。
  如果 `HTTP_PORT != 80`，将跳过自动签发（将其设为 80，或手动运行 certbot）。
- 续期：`certbot` 容器每 12 小时运行一次 `certbot renew --quiet`；nginx 每 6 小时
  自动重载以获取新证书（certbot 内不使用 docker CLI）。

`--cert-name <DOMAIN>` 使 certbot 写入 `data/certbot/etc/live/<DOMAIN>`，
这正是 nginx 模板读取的位置。

---

## 服务器信息（Server Info）

`GET /api/server-info` 会返回每个字段的**来源**：

| 字段          | 来源（优先级）                                              |
|---------------|-------------------------------------------------------------|
| address       | 手动覆盖 → `DOMAIN` 环境变量 → 请求 Host                    |
| relay address | 手动覆盖 → `RELAY_ADDRESS` 环境变量 → 与 address 相同       |
| api server    | 手动覆盖 → `RUSTDESK_API_SERVER` 环境变量 → 空（未使用）    |
| ports         | 手动覆盖 → 环境变量种子 → 栈默认值                          |
| public key    | 手动覆盖 → `data/hbbs/id_ed25519.pub`                       |

客户端/Web 客户端使用这些值；在新栈上 hbbs 首次启动时生成密钥，后端会自动读取
（来源为 `rustdesk-server`）。

---

## RustDesk Web 客户端

要通过 Web 客户端（https://rustdesk.com/web）连接，请在面板的 Server Info 中
填入你的 `DOMAIN` 和端口，并使用面板中的密钥。nginx 的 CORS 响应头允许
`rustdesk.com`/`web.rustdesk.com` 来源。

---

## 客户端配置代码

仪表盘会根据当前 Server Info（`GET /api/server-info/connect-code`）生成可直接
分发的**客户端配置代码**。将 **Config code** 复制到 RustDesk 客户端并粘贴到
**设置 → 网络 → 导入** 中 —— 客户端会自动应用 ID/中继服务器、可选 API 服务器
和密钥：

| 形式          | 示例 |
|---------------|------|
| Config code | `=0nI9smcPhWR0YVcz1mekllS3JDbVNm...` —— 对 JSON `{"host","relay","api","key"}` 做反向 base64url 编码（带填充） |
| Raw JSON | `{"host":"<your-domain>","relay":"<your-domain>","api":"","key":"<your-public-key>"}` —— Import 也接受 |
| 替代格式 | `host=<your-domain>,key=<your-public-key>,relay=<your-domain>` |

该代码**不带签名**：客户端解码器（`flutter/lib/common.dart` 中的
`ServerConfig.decode`）先尝试原始 JSON，再尝试反向 base64url 形式 —— 后端会同时
生成这两种形式。托管 Web 控制台使用的签名形式无法在此复现（其签名密钥是私有的）。
非默认的 ID/中继端口会以 `host:port` 形式嵌入对应字段。主机可以是域名、IPv4
地址或用方括号包裹的 IPv6 地址；API 服务器值若设置，则必须是完整的
`http(s)://` URL。

---

## 开发模式（dev overlay）

air + Vite 开发服务器的热重载（镜像较大，需要磁盘/内存）：

```
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

前端开发服务器监听宿主 5173 端口。后端在 `air` 下运行，文件变更时自动重建。

---

## 下载源与镜像（Block C）

栈的所有外部下载都经过少数几个明确定义的源，可手动从 `.env` 重定向（见
`.env.example` 的 `Block C` 段落）。修改后重新应用：再次运行 `./setup.sh`
（或 `docker compose build`）。

| 流量                                 | 可被覆盖的变量         | 默认源                                              |
|--------------------------------------|------------------------|-----------------------------------------------------|
| Docker 镜像（运行期 + 基础 `FROM` 镜像） | `DOCKER_REGISTRY_PREFIX` | Docker Hub（如 `postgres:16-alpine`）         |
| Go 模块 + `air` 工具                 | `GOPROXY`              | `https://proxy.golang.org,direct`                 |
| npm 包（前端）                       | `NPM_REGISTRY`         | `https://registry.npmjs.org`                      |
| Alpine apk 包                        | `APK_MIRROR`           | `https://dl-cdn.alpinelinux.org/alpine`           |

示例：

```
# 全部经私有镜像仓库拉取
DOCKER_REGISTRY_PREFIX=registry.example.com/

# 使用 Go 模块代理镜像（国内 / 受限网络）
GOPROXY=https://goproxy.cn,direct

# 使用 npm 镜像
NPM_REGISTRY=https://registry.npmmirror.com

# 使用 Alpine 镜像（保持 /v3.xx 路径，仅替换主机）
APK_MIRROR=https://mirror.example.com/alpine
```

注意：
- 变量留空则保持官方源。
- `DOCKER_REGISTRY_PREFIX` 会前置到每个镜像引用（compose 的 `image:` 和 Dockerfile
  的 `FROM`），包括构建器/基础镜像。
- `APK_MIRROR` 只替换构建镜像内的主机
  `https://dl-cdn.alpinelinux.org/alpine`，因此 `/v3.xx/{main,community}` 路径
  始终与基础镜像的 Alpine 版本匹配。
- 故障切换是手动的：Docker 不会自动切换到镜像。请在受网络限制的宿主机上预先
  设置好这些值。

---

## 构建后的 Docker 清理（Block D）

`./setup.sh` 会在最后清理未使用的 Docker 资源（见 `.env.example` 的 `Block D`），
避免构建占满磁盘 —— 对小 VPS 很重要。

| `DOCKER_PRUNE_ON_BUILD` | 会删除的内容                                        |
|-------------------------|-----------------------------------------------------|
| `all`（默认）            | 未被运行容器使用的镜像（如 `golang`/`node`/`python` alpine 等基础构建镜像下次重建时会重新拉取）、停止的一次性容器、未使用的网络/卷 |
| `safe`                  | 仅悬空镜像 + 构建缓存                                |
| `none`                  | 不做清理                                            |

绝不会动：运行中的栈实际使用的镜像（`rustdesk-stack-*`、`postgres`、`nginx`、
`certbot`、`rustdesk-server`）以及 `data/` 卷。若 `all` 删除了基础构建镜像，
下次 `./setup.sh` 会重新下载（约 500 MB）。磁盘紧张时，在重建中断后再次运行
`./setup.sh` 前手动执行 `docker image prune -a -f` 也有帮助。

---

## 备份与迁移

**所有状态都保存在 `rustdesk-stack/` 内：**

- **服务器身份 + 设备**：`data/hbbs/`（务必保留 `id_ed25519*` 和 `db_v2.sqlite3*`）。
  只有不关心密钥/设备时才能全新安装。
- **面板数据库**：`data/postgres/` —— **停止栈之后**再复制
  （`docker compose stop postgres`）。`.env` 中的 `POSTGRES_PASSWORD` 必须保持不变，
  它已嵌入复制集群的角色中。
- **TLS**：`data/certbot/etc/`（用 `cp -a` 保留符号链接）。

### 迁移到生产主机

```
# 旧主机
docker compose stop postgres
mkdir -p ~/rustdesk-migrate && cp -a rustdesk-stack/data ~/rustdesk-migrate/data
tar czf ~/rustdesk-migrate/data.tgz -C ~/rustdesk-migrate data

# 新主机
git clone https://github.com/pierce1stg/RustDeskAdmin.git && cd RustDeskAdmin
cp .env.example .env            # 设置 DOMAIN、EMAIL、相同的 POSTGRES_PASSWORD
mkdir -p data && tar xzf ~/rustdesk-migrate/data.tgz -C .
./setup.sh
```

如果更倾向 SQL 转储，也可以对面板数据库使用 `pg_dump`/还原。

---

## 故障排查

- **构建时磁盘满**：默认生产镜像很小；请确保没有其它内容占满宿主机。
  若 RAM < 2GB 请添加 swap。旧构建镜像会堆积在 `/var/lib/containerd`——清理：
  ```
  docker image prune -a -f; docker system prune -f
  ```
- **hbbr 无限重启**：`docker compose logs hbbr` —— 通常是端口冲突或缺少 `/data`
  （绑定 `./data/hbbs`）。
- **证书签发失败 / nginx “cannot load certificate”**：旧版将 `live/<DOMAIN>` 占位目录移开以配合
  certbot，留下一段 nginx 崩溃循环、ACME 收到 “connection refused” 的窗口。新版 `setup.sh`
  在 `live/<DOMAIN>` 保留普通占位证书（nginx 永不丢失），将真实证书签入独立的
  `live/<DOMAIN>-le` 线性目录，成功后用软链接把 `live/<DOMAIN>` 指向它。配合 nginx 健康检查、
  80 端口预检和 3 次重试，首次运行即可成功。
- **presence.json 为空**：确保 `presence` 容器能访问 docker socket（需要
  `privileged` + `pid: host`，compose 文件已提供），并确保
  `rustdesk-hbbs`/`rustdesk-hbbr` 容器存在。
- **模块无法联网下载**：后端生产镜像使用 `go mod vendor` 构建，不携带模块缓存；
  前端镜像为静态包。
- **无法登录**：密码必须 ≥8 个字符；设置种入后以数据库为准 —— 仅改 `.env`
  不会生效，直到你在面板中修改它。
- **一段时间后被退出/会话反复掉线**：当 access 令牌过期且 refresh 令牌无法继续
  续约会话时，面板会将你登出。请在**设置 → 会话**中调整时长（或在新栈上通过
  `ACCESS_TOKEN_TTL_MINUTES` / `REFRESH_TOKEN_TTL_DAYS` 重新种入）。会话保存在
  postgres 中，除非数据目录被清空，否则能扛过后端重启。

---

## API（参考）

| 方法   | 路径                        | 说明                                          |
|--------|-----------------------------|-----------------------------------------------|
| POST   | `/api/auth/login`           | 登录，返回 access+refresh JWT                 |
| POST   | `/api/auth/refresh`         | 刷新 access 令牌                              |
| PUT    | `/api/auth/password`        | 修改管理员凭据（≥8 个字符）                   |
| GET    | `/api/devices`              | 设备列表（分页）                              |
| PATCH  | `/api/devices/:id`          | 更新设备（alias、pinned）                     |
| DELETE | `/api/devices/:id`          | 删除设备                                      |
| GET    | `/api/status`               | 实时 hbbs/hbbr 状态 + 在线连接                |
| GET    | `/api/devices/stream`       | SSE：在线/离线状态实时推送                    |
| GET    | `/api/settings`             | 设置                                          |
| PUT    | `/api/settings/:key`        | 更新某项设置                                  |
| PUT    | `/api/settings/auth_access_token_ttl_minutes` | 设置 access 令牌有效期（分钟） |
| PUT    | `/api/settings/auth_refresh_token_ttl_days`   | 设置会话时长（天）             |
| GET    | `/api/server-info`          | 带来源的地址/端口/密钥                        |
| GET    | `/api/server-info/connect-code` | 客户端配置代码：`json`（反向 base64url）、`raw`（JSON）、`comma`（host=...） |
| GET    | `/health`                   | 健康检查                                      |

认证：请求头 `Authorization: Bearer <access_token>`。