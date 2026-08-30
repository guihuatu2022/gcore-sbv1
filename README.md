# gcore-singbox（加固版）

在 Gcore Container as a Service（最小档 80mCPU-128MiB / 自动伸缩 0-1 / linux/amd64）上部署 sing-box **VLESS + WS + TLS + CDN** 代理，前置 Cloudflare Worker 做反代 + 伪装站（软件下载站主题，全新设计）。

> 本项目由 Scaleway 版（`scw-sbv2-ok`）改造而来。主要差异见下方[安全模型](#安全模型与-scaleway-版的差异)。

## 安全模型（与 Scaleway 版的差异）

原 Scaleway 版靠"容器 Private + IAM Token + 仅放行 Cloudflare IP"实现**纵深防御**：无凭据/非 CF 来源的请求在平台鉴权层直接 403，**容器根本不启动**，从而避免域名扫描导致冷启动。

**Gcore CaaS 目前不具备等价能力**：

- 无"Private 容器"模式；
- 唯一的端点访问控制 `is-api-key-auth`（API Key 鉴权）被 Gcore 官方**临时禁用**（"using CaaS with authorization is currently not supported"）；
- 安全组/防火墙**只作用于虚拟机实例，不作用于 CaaS 容器**，无法做源 IP 白名单。

因此 Gcore 版的容器端点（`*.cloud.gcore.dev`）是**公网可达**的。本项目改用以下**降低被发现概率**的措施（注意：是隐蔽，不是鉴权）：

1. **容器名随机化**：用 26+ 位随机字母命名容器，使分配的默认域名子串高熵、不在任何字典里，挡住子域名字典爆破扫描。
2. **高熵 WS_PATH**：未设置即启动失败，强制部署时设置随机路径（如 `/db/<32位hex>.iso`）。
3. **Worker 共享密钥闸门**：WS 路径转发前校验 `X-Proxy-Token`，无凭据请求直接返回伪装页，不转发到容器。
4. **出站 SSRF 防护**：sing-box `route` 层 `ip_is_private` 走 block 出站，挡掉 Gcore 元数据 `169.254.169.254` 等内网（Scaleway 元数据 `169.254.42.42` 同在该网段内，已被覆盖）。
5. **短 idle timeout**：容器无流量快速缩到 0，降低被持续探测的窗口。

> 已知残余风险：若容器域名泄露（Worker 配置/日志/客户端泄露，或证书透明度日志暴露子域名），定向扫描仍会唤醒缩到 0 的容器。这是 Gcore CaaS 缺端点鉴权导致的、应用层无法绕过的限制。详见[局限](#局限)。如需"扫描绝不唤醒容器"的硬保证，请改用 Gcore 虚拟机 + 安全组（仅放行 CF IP），或留在 Scaleway。
>
> 特别注意：**伪装站（SoftVault）只保护 Worker 自定义域名这条入口，不保护 Gcore 容器域名本身。** 直接访问 `ORIGIN_DOMAIN` 不会看到 SoftVault 伪装页，而是命中 sing-box / 平台响应。所以容器域名必须当成"半敏感"信息，只存在 Worker 变量里，不外泄。

## 加固点（相对原版）

1. **Worker 共享密钥闸门**：WS 路径转发前校验 `X-Proxy-Token`，无凭据请求直接返回伪装页，不激活容器 → 防爬虫/主动探测导致冷启动。
2. **高熵 WS_PATH 强制**：仓库公开，默认路径等于公开；改为未设置即启动失败，强制部署时设置高熵随机路径。
3. **出站 SSRF 防护**：sing-box `route` 层 `ip_is_private` 走 block 出站，挡掉云平台元数据与内网地址。
4. **伪装站细节**：`robots.txt` / `favicon` 齐全，外链加 `rel="noopener noreferrer"`，站名与代理/基础设施无关。
5. **客户端联动**：uTLS chrome 指纹 + mux + 0-RTT early data，与服务端严格对齐。

## 关键修复：sing-box 1.12+ 配置格式迁移

原版用的是 sing-box 1.11 及更早的 DNS / domain_strategy 旧格式，**在 sing-box v1.13.12 下 `sing-box check` 直接 FATAL、容器启动失败**。本版已迁移到 1.12+ 新格式：

- DNS server：`address: "1.1.1.1"` → `{ "type": "udp", "tag": "resolver", "server": "1.1.1.1" }`
- 出站解析：direct 的 `domain_strategy` → `domain_resolver: { server, strategy }`
- 全局解析：`route.default_domain_resolver: { server, strategy }`

迁移依据见 [sing-box 迁移文档](https://sing-box.sagernet.org/migration/)。

## 架构

```
客户端 ──HTTPS/WSS──> Cloudflare Worker (自定义域名，Cloudflare 托管 DNS)
                         ├── WS_PATH + X-Proxy-Token → 反代到 Gcore CaaS 容器 (Host 覆写)
                         │                              └── sing-box VLESS+WS (0.0.0.0:8080)
                         │                                   └── route: 私网/元数据 → block
                         ├── /robots.txt /favicon.ico → 站点辅助文件
                         └── 其他路径 → 返回伪装页面 (SoftVault 软件下载站)
```

## 需要准备的 3 个秘密值

部署前先生成以下 3 个值，记到密码管理器里（比原版少 1 个 `CONTAINER_TOKEN`，因 Gcore 无端点鉴权）：

| 名称 | 怎么生成 | 用在哪 |
|------|---------|--------|
| `UUID` | `sing-box generate uuid` 或 `uuidgen` | Gcore 容器环境变量 + Karing |
| `WS_PATH` | 32 位十六进制，如 `/db/8f3a2c1e9b7d4056a1c2e8f0b3d4a5c6.iso` | Gcore 容器 + Worker + Karing（三处必须完全一致） |
| `WS_SECRET` | 32 位随机字符串（`openssl rand -hex 16`） | Worker 变量 + Karing 的 `X-Proxy-Token` 头 |

---

## 部署步骤

### 步骤 0：本地生成秘密值

```bash
# UUID
sing-box generate uuid          # 或 uuidgen

# WS_PATH（高熵随机路径）
echo "/db/$(openssl rand -hex 16).iso"

# WS_SECRET（共享密钥）
openssl rand -hex 16
```

把这三个值记下来。

### 步骤 1：推送代码到 GitHub 并构建镜像

```bash
git clone https://github.com/<你的用户名>/gcore-sb.git   # 你 fork 后的仓库
cd gcore-sb
# 改 remote 指向你的 fork，push
git push -u origin main
```

GitHub Actions（`.github/workflows/build.yml`）会自动构建 `linux/amd64` 镜像并推送到 GHCR：

```
ghcr.io/<你的用户名>/gcore-sb:latest
```

到仓库 **Actions** 页确认构建成功（绿勾）后继续。**重要**：GHCR 包默认是私有的，去 `https://github.com/users/<你的用户名>/packages/container/gcore-sb/settings` 把 Package visibility 改为 **Public**，否则 Gcore 拉不到镜像。（也可改用 Docker Hub 公开仓库。）

> 仓库是 public 的话，**不要把真实的 UUID/WS_PATH/WS_SECRET 提交进代码或环境变量文件**。它们只通过 Gcore 控制台和 Worker 变量注入，不出现在仓库里。

### 步骤 2：创建 Gcore CaaS 容器

Gcore 控制台 → **Cloud → Container as a Service**：

1. **区域**：在控制台选任意 CaaS 支持的区域即可，项目本身与区域无关。若你要美国出口，可选 **Manassas**（弗吉尼亚）或 **Chicago**（伊利诺伊）；也可选 Frankfurt / Amsterdam / Singapore / Tokyo 等任意区域。若提示需配额，点 **Ask for quotas** 填写简短说明（如 "for testing"），Gcore 称通常几分钟审核通过。
2. **容器名**：用一个 **26+ 位随机字母**串（如 `qzxwvnkpmytrcladhbsoeinfjg`），让分配的默认域名高熵、难被扫描。可用 `openssl rand -hex 13` 或 `tr -dc 'a-z' < /dev/urandom | head -c 26` 生成。
3. **镜像**：`ghcr.io/<你的用户名>/gcore-sb:latest`（公开）。
4. **Flavor（资源）**：`80mCPU-128MiB`（最小档，与本项目调优匹配）。
5. **Listening port**：`8080`（与镜像内 `PORT` 默认值对齐）。
6. **自动伸缩**：`scale.min = 0`、`scale.max = 1`、`timeout = 60`（无流量 60s 后缩到 0）。
7. **环境变量**（Settings → Environment Variables）：
   - `UUID` = 步骤 0 的 UUID
   - `WS_PATH` = 步骤 0 的高熵路径（如 `/db/8f3a....iso`）
   - `LOG_LEVEL` = `error`
8. **部署**。部署成功后会得到一个容器域名，格式类似：
   ```
   https://<你的随机容器名>-<编号>-caas.<区域子域>.cloud.gcore.dev
   ```
   记下这个域名 = `ORIGIN_DOMAIN`。

### 步骤 3：（Gcore 无此步骤）关于端点鉴权

原 Scaleway 版在此步把容器设为 Private + IAM Token + 仅放行 CF IP。**Gcore CaaS 没有等价能力**（API Key 鉴权被官方临时禁用、无 IP 白名单、安全组不作用于 CaaS）。因此本版**不依赖端点鉴权**，仅靠步骤 2 的随机容器名 + 高熵 WS_PATH + Worker 的 `X-Proxy-Token` 闸门做"降低被发现概率"。

> 你可以开工单问 Gcore 能否为你的 CaaS 容器启用端点 API Key 鉴权（`is-api-key-auth`）。若未来 Gcore 恢复该功能，可在 Worker 反代时加上鉴权头，进一步收紧。当前以"隐蔽 + 应用层闸门"为准。

### 步骤 4：部署 Cloudflare Worker

1. 把仓库里的 `_workers.js` 内容粘到 Cloudflare 控制台 **Workers & Pages** → 新建 Worker 的编辑器里（或用 `wrangler deploy`）。
2. Worker **Settings → Variables** 里添加 3 个变量（敏感的设为 **Secret/加密**）：

   | 变量 | 值 | 是否 Secret |
   |------|-----|------------|
   | `WS_PATH` | 步骤 0 的高熵路径（与容器一致） | 可普通 |
   | `ORIGIN_DOMAIN` | 步骤 2 的 Gcore 容器域名（去掉 `https://`） | 是 |
   | `WS_SECRET` | 步骤 0 的共享密钥 | 是 |

3. 给 Worker 绑定**自定义域名**（你已在 Cloudflare 托管 DNS 的域名）：
   - Worker Settings → **Triggers** → **Custom Domains** → 加你的域名。
   - 客户端的 `server` / `server_name` 都填这个自定义域名。

### 步骤 5：验证伪装站

浏览器访问你的 Worker 自定义域名：

- `https://你的域名/` → 看到 **SoftVault** 软件下载站首页
- `https://你的域名/downloads` → 下载目录页
- `https://你的域名/docs` → 验证说明文档页
- `https://你的域名/你的WS_PATH`（普通 GET，不带密钥头）→ 返回"Your download is ready"直链伪装页（不是 404，不是 sing-box 错误）
- `https://你的域名/任意不存在的路径` → 404 页

只要不带 `X-Proxy-Token` 头，命中 WS 路径也只返回伪装页、不转发到容器——这就是闸门生效的标志。

### 步骤 6：Karing 客户端配置

仓库里的 `karing-client-template.json` 是模板，填入对应值：

```json
{
  "type": "vless",
  "tag": "gcore-singbox",
  "server": "你的自定义域名",
  "server_port": 443,
  "uuid": "你的UUID（与容器一致）",
  "flow": "",
  "transport": {
    "type": "ws",
    "path": "/db/你的高熵路径.iso（与容器一致）",
    "headers": { "X-Proxy-Token": "你的WS_SECRET" },
    "max_early_data": 2048,
    "early_data_header_name": "Sec-WebSocket-Protocol"
  },
  "tls": {
    "enabled": true,
    "server_name": "你的自定义域名",
    "insecure": false,
    "utls": { "enabled": true, "fingerprint": "chrome" }
  },
  "multiplex": { "enabled": true, "padding": false }
}
```

Karing 操作：
1. 打开 Karing → 配置 → 新建 → 选 **手动输入 / sing-box JSON**（或导入 JSON 文件）
2. 把上面填好值的 JSON 作为单节点导入
3. 选中该节点，开启系统代理/TUN 即可

**联动要点（三处必须严格一致，否则连不上）**：
- `path` = 容器的 `WS_PATH` = Worker 的 `WS_PATH`
- `X-Proxy-Token` 头值 = Worker 的 `WS_SECRET`
- `uuid` = 容器的 `UUID`
- `max_early_data` + `early_data_header_name` = 与服务端 config 一致（已对齐为 2048 / `Sec-WebSocket-Protocol`）
- `multiplex.enabled` = true（服务端也开了），`padding` 两端一致（默认 false）

---

## 行为说明与排障

- **冷启动**：容器缩到 0 后，首次连接会有几百 ms ~ 数秒延迟（拉镜像 + sing-box 初始化）。镜像很小（busybox + 单二进制），已尽量压低。Gcore 文档称 provisioning 约 30-60s，部署后 ingress 路由收敛期间可能短暂 503（1-2 分钟）。
- **日志脱敏**：启动日志里 UUID 和 WS_PATH 都显示 `***`，排查时去 Gcore 控制台看容器日志。
- **排障模式**：临时把容器环境变量 `LOG_LEVEL` 改成 `debug`，排查完改回 `error`。
- **连不上排查顺序**：
  1. 浏览器访问 WS 路径应返回伪装页（说明 Worker 在线）
  2. 检查 Karing 的 `path` / `X-Proxy-Token` / `uuid` 是否三处一致
  3. Gcore 控制台确认容器状态为 Running / Ready，`listening_port=8080`、`scale.min=0/max=1`
  4. Worker 变量是否 3 个都配了（缺一个会 503）
  5. **WebSocket 是否真的通**：Gcore CaaS 对 WebSocket 的支持官方文档未明确声明，若 WS 握手失败，这是平台限制（详见[局限](#局限)）

## 局限（Gcore CaaS serverless HTTP 架构天花板）

- **容器域名公网可达**：Gcore CaaS 无端点鉴权（API Key 鉴权被禁用）、无源 IP 白名单。本版靠随机容器名 + 高熵 WS_PATH 降低被发现概率，但**不是鉴权**。若域名泄露，定向扫描仍会唤醒缩到 0 的容器（冷启动成本 + 指纹暴露风险）。要"扫描绝不唤醒容器"的硬保证，需换 Gcore 虚拟机 + 安全组（仅放行 CF IP），或留在 Scaleway。
- **WebSocket 支持未证实**：Gcore CaaS 文档未明确声明支持 WebSocket。VLESS+WS 强依赖长连接，若平台不支持 WS 升级，代理将不工作。**上线前务必实测**（完成上述部署后用 Karing 实际连一次确认）。
- **最大连接时长未知**：Gcore 文档未给出请求/连接最大时长；`timeout` 字段是"闲置缩容超时"（≤180s），不是请求超时。原 Scaleway 依赖单条 WS 最长 3600s 才被切断，Gcore 上长连接是否被更早切断未知。
- **GFW 流量指纹**：VLESS+WS+TLS+CDN 对长时间大流量仍相对易被识别。已用 uTLS chrome 指纹 + mux 缓解；敏感时期可把两端 `multiplex.padding` 同步改为 `true`。
- **不适合大流量稳定传输**（4K 视频、大文件长传、实时游戏），适合轻度间歇性浏览。要彻底解决需换支持裸 TCP 的平台（小 VPS + Reality）。

## 构建说明

- sing-box 版本：v1.13.12
- 构建不带任何 `-tags`，只含 VLESS + WS 核心功能
- 运行时 busybox:1.36-musl，镜像几 MB
- Go 运行时参数：`GOMAXPROCS=1, GOMEMLIMIT=100MiB, GOGC=off`
- Gcore CaaS 最小 flavor：`80mCPU-128MiB`，`linux/amd64`
