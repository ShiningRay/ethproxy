# ethproxy

Ethereum JSON-RPC 反向代理：多上游负载均衡与故障转移、同步状态感知的健康检查、按请求/响应性质分级缓存。

## 特性

- **多上游**：加权 round-robin；传输层失败自动切换到下一个健康节点（`eth_sendRawTransaction` 等有副作用的方法不重试）
- **健康与同步检查**：后台主动轮询 `eth_syncing` + `eth_blockNumber` + `eth_chainId`；同步中、连续失败超过阈值、或落后池内最大高度超过 `maxBlockLag` 的节点会被摘除，恢复后自动重新入池
- **链一致性保护**：配置 `chainId` 后，报告其他链 ID 的节点直接摘除，防止误配不同链的上游；未配置时自动采用多数节点的 chainId 作为基准
- **分级缓存**（不是无脑缓存）：
  - 永久缓存：按 hash 定位的不可变数据（区块、交易、已打包的收据）、最终确认的区块号查询（区块号 ≤ 链头 − `finalityDepth`）、链常量（`eth_chainId` 等，1h TTL）
  - 短 TTL（默认 2s）：`eth_blockNumber`、`eth_gasPrice`、带 `latest`/`safe`/`finalized` 标签的状态查询等链头相关数据
  - 不缓存：`eth_sendRawTransaction` 等写方法、`pending` 标签、未来区块、`admin_*`/`debug_*` 等管理命名空间、未识别方法（fail-safe）
- **可插拔缓存后端**：内存 LRU（默认）或 Redis；实现 `CacheBackend` 接口即可扩展
- **批量请求**：数组请求逐项走缓存管线，未命中项按缓存性分流（可缓存项走 single-flight，其余合并为单次批量转发）
- **Single-flight 防拥堵**：同一缓存键的并发未命中只发一次上游请求，其余请求共享该结果，避免短 TTL 过期瞬间的惊群效应
- **公网加固**：默认拒绝 `admin_*`/`debug_*`/`personal_*` 等命名空间；限制批量请求大小、请求体大小和 `eth_getLogs` 区块跨度
- **WebSocket 透传**：客户端 WS 连接固定到一个健康上游，帧双向原样转发；上游断开会关闭客户端连接，由客户端重连后落到健康节点（不做订阅状态管理）
- **运维端点**：`GET /` 索引页（浏览器访问，实时展示链高与各上游状态）、`GET /healthz`（无健康上游返回 503）、`GET /status`（JSON 状态）

## 快速开始

```bash
npm install
cp config.example.yaml config.yaml   # 按实际节点修改 upstreams
npm run dev -- config.yaml           # 开发模式
# 或
npm run build && npm start -- config.yaml
```

客户端把节点地址指向 `http://127.0.0.1:8545` 即可。

## Docker

```bash
docker build -t ethproxy .
docker run -p 8545:8545 -v "$PWD/config.yaml:/app/config.yaml:ro" ethproxy
```

配置文件通过挂载注入；也可以传自定义路径：`docker run ... ethproxy /etc/ethproxy/prod.yaml`。

## 配置

见 [config.example.yaml](config.example.yaml)，关键项：

| 配置 | 说明 | 默认 |
|---|---|---|
| `upstreams[].url` / `weight` | 上游节点地址与权重 | — |
| `chainId` | 期望的链 ID（如 1 = 主网）；不配则取多数节点为准 | 自动检测 |
| `health.pollIntervalMs` | 健康轮询间隔 | 5000 |
| `health.maxBlockLag` | 落后池内最大高度多少块算掉队 | 5 |
| `health.failureThreshold` | 连续失败多少次摘除 | 3 |
| `health.maxRetries` | 单请求最多尝试几个上游 | 2 |
| `health.retryBaseDelayMs` / `retryMaxDelayMs` | 重试指数退避：`base * 2^(n-1)`，封顶 max | 100 / 1000 |
| `cache.backend` | `memory` 或 `redis` | `memory` |
| `cache.shortTtlMs` | 链头相关数据 TTL（dynamicTtl 开启时为上限/回退值） | 2000 |
| `cache.dynamicTtl` | 按观测出块间隔动态调整短 TTL（间隔/4，钳制在 `[minTtlMs, shortTtlMs]`） | true |
| `cache.finalityDepth` | 多少块深度视为不可变 | 64 |
| `cache.redis.url` / `keyPrefix` | Redis 连接与键前缀 | — |

## 缓存策略细节

判定逻辑在 [`src/cache-rules.ts`](src/cache-rules.ts)：`requestPolicy(method, params, ctx)` 在请求阶段决定能否缓存，`responseTtl()` 依据响应内容修正（例如 `eth_getTransactionReceipt` 只有含 `blockHash` 才永久缓存，`null` 只给极短 TTL）。缓存键为 `method + sha256(规范化 params)`。

## 扩展缓存后端

实现 `src/cache/types.ts` 中的接口并在 `src/cache/index.ts` 的工厂注册：

```ts
interface CacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number | null): Promise<void>; // null = 不过期
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}
```

缓存后端故障会降级为缓存未命中，不影响代理转发。

## 部署在 Cloudflare 之后（DDoS 防护建议）

ethproxy 自身只承担应用层防护（方法黑名单、请求形状限制、缓存吸收、single-flight）。完整的防护应当分层，外层由 Cloudflare 和基础设施承担：

**Cloudflare 侧（收益最大，优先做）：**

- L3/L4 流量型攻击（SYN flood、UDP 放大等）由 CF 代理模式天然吸收，源站无感
- 开启 WAF 托管规则、Rate Limiting（如单 IP 每秒 N 请求）、Bot Fight Mode
- **源站锁定**：安全组/防火墙只对 [Cloudflare 官方 IP 段](https://www.cloudflare.com/ips/) 放行 80/443，防止攻击者绕过 CF 直连源站——不做这一步，CF 的防护形同虚设
- SSL 模式建议 Full (Strict) + Cloudflare Origin Certificate（拒绝自签名/过期证书的中间人风险）

**nginx / 网关侧：**

- `limit_req_zone` 按 IP 限速、`limit_conn` 限制并发连接
- WebSocket 升级头映射与长连接超时（本项目部署示例见下文）
- 代理时透传真实客户端 IP（`X-Forwarded-For` / CF 的 `CF-Connecting-IP`），供后续限流使用

**ethproxy 侧（已实现）：**

- 默认拒绝 `admin_*` / `debug_*` / `personal_*` 等危险命名空间（`debug_traceTransaction` 一个请求就能让节点 CPU 跑满数秒，是典型的应用层攻击武器）
- 限制批量请求元素数、请求体大小、`eth_getLogs` 区块跨度
- 分级缓存 + single-flight：热点只读请求基本不打上游
- 健康检查 + 故障摘除：上游异常时快速失败而不是请求堆积

**部署参考**（本项目生产环境结构）：

```
客户端 → Cloudflare (WAF/限速/TLS) → nginx (WS 升级/限速) → ethproxy (127.0.0.1:8545) → 上游节点
```

## 开发

```bash
npm test          # vitest（单元 + 集成，mock upstream）
npm run typecheck # tsc --noEmit
```

## 范围外（暂未实现）

- WebSocket 的订阅状态管理与断线自动重订阅（当前为纯透传，重连由客户端负责）
- 请求限流、鉴权
