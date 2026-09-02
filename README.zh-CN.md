# ethproxy

[English README](README.md)

Ethereum JSON-RPC 反向代理：多上游负载均衡与故障转移、同步状态感知的健康检查、按请求/响应性质分级缓存。

## 特性

- **多上游**：加权 round-robin；传输层失败自动切换到下一个健康节点（`eth_sendRawTransaction` 等有副作用的方法不重试）
- **健康与同步检查**：后台主动轮询 `eth_syncing` + `eth_blockNumber` + `eth_chainId`；同步中、连续失败超过阈值、或落后池内最大高度超过 `maxBlockLag` 的节点会被摘除，恢复后自动重新入池
- **newHeads 链高跟踪**：上游 WS 可用时，池为其维持一条持久的 `eth_subscribe("newHeads")` 连接，每收到通知即更新本地观测链高（断线指数退避重连）；WS 不可用或断开时自动回退为 HTTP 健康轮询获取块高。可用 `health.wsHeads: false` 关闭（块高仅来自 HTTP 轮询，WS 可用性改为每轮探测）
- **重组检测**：对每个去重后的 newHeads 校验 parentHash 与近期区块头滑动窗口（`reorg.windowSize`，默认 128）的连续性。冲突先仲裁后告警——分歧头只有在被后续块接续、或被第二个不同上游报出相同哈希时才判定为重组，短暂不一致的节点不会产生误报。确认的重组会记录深度与分叉区间日志，计入 `ethproxy_reorgs_detected_total` / `ethproxy_reorg_depth` 指标，并经 `pool.onReorg` 广播。依赖 `health.wsHeads`（HTTP 轮询拿不到块哈希）
- **新区块缓存加热**：每个 newHeads 推送都会被写入响应缓存，效果等同于刚应答过对应的 `eth_getBlockByNumber`/`eth_getBlockByHash`（推送只有区块头时，向推送方节点后台补拉一次完整块；推送自带交易列表时直接缓存）。条目使用链头短 TTL，重组的头块会很快过期；多个上游重复推送同一区块按哈希去重，只补拉一次
- **链一致性保护**：配置 `chainId` 后，报告其他链 ID 的节点直接摘除，防止误配不同链的上游；未配置时自动采用多数节点的 chainId 作为基准
- **分级缓存**（不是无脑缓存）：
  - 永久缓存：按 hash 定位的不可变数据（区块、交易、已打包的收据）、最终确认的区块号查询（区块号 ≤ 链头 − `finalityDepth`）、链常量（`eth_chainId` 等，1h TTL）
  - 短 TTL（默认 2s）：`eth_gasPrice` 等链头相关数据
  - 不缓存：`eth_sendRawTransaction` 等写方法、`pending` 标签、未来区块、`admin_*`/`debug_*` 等管理命名空间、未识别方法（fail-safe）
- **latest 一致性**：`latest` 标签（含参数缺省的隐含 latest）在进入缓存/转发前翻译为本地观测的池链高 H——同一轮询窗口内所有客户端读到一致的数据，缓存键稳定为 `(method, H)`；翻译后的请求只路由到 `blockNumber >= H` 的节点，无节点满足时回退为原始 `latest` 请求且结果不缓存；`eth_blockNumber` 直接由本地链高应答，不打上游
- **可插拔缓存后端**：内存 LRU（默认）或 Redis；实现 `CacheBackend` 接口即可扩展
- **批量请求**：数组请求逐项走缓存管线，未命中项按缓存性分流（可缓存项走 single-flight，其余合并为单次批量转发）
- **Filter 粘滞路由**：`eth_newFilter`/`eth_newPendingTransactionFilter` 的响应会被改写为代理生成的全局唯一 ID（节点本地 ID 跨节点会冲突）；`eth_getFilterChanges`/`eth_getFilterLogs`/`eth_uninstallFilter` 换回节点本地 ID 并固定路由到创建它的上游。映射空闲超过 `filters.stickyTtlMs`（默认 5 分钟，对齐 geth 的 filter 过期）即失效，每次轮询会刷新。链高跟踪开启时（`health.wsHeads`），`eth_newBlockFilter` 完全由代理本地应答——ID 由代理签发，轮询结果来自本地观测到的新头缓冲，零上游调用
- **Single-flight 防拥堵**：同一缓存键的并发未命中只发一次上游请求，其余请求共享该结果，避免短 TTL 过期瞬间的惊群效应
- **公网加固**：默认拒绝 `admin_*`/`debug_*`/`personal_*` 等命名空间；限制批量请求大小、请求体大小和 `eth_getLogs` 区块跨度
- **WebSocket 分流处理**：普通 JSON-RPC 请求走与 HTTP 相同的代理管线（缓存、负载均衡、重试全部生效）；`eth_subscribe("newHeads")` 由代理本地应答——订阅 ID 由代理签发，池自身观测到的新头按区块哈希去重后扇出给所有订阅者，N 个客户端不再占用 N 条上游连接；开启 `txpool.mirror: true` 后 `eth_subscribe("newPendingTransactions")` 同样本地应答（交易哈希去重后扇出），开启 `syncing.mirror: true` 后 `eth_subscribe("syncing")` 也本地应答（聚合状态：任一上游同步中即为 syncing，订阅后立即回当前状态，之后只在变化时推送）；其他 `eth_subscribe`/`eth_unsubscribe` 通过该客户端专属的上游 WS 长连接透传（订阅状态在节点上），订阅通知原样回推；上游订阅连接断开则关闭客户端连接，由客户端重连重订阅
- **运维端点**：`GET /` 索引页（浏览器访问，实时展示链高、各上游状态与本地应答统计）、`GET /healthz`（无健康上游返回 503）、`GET /status`（JSON 状态，含缓存命中与本地应答明细）、`GET /metrics`（Prometheus 指标：按方法的请求数/延迟直方图、上游健康/高度/延迟、缓存统计、按类别的 `ethproxy_local_responses_total`）

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
| `statusPagePath` | 状态展示页路径；`false` 完全禁用页面（`/status` JSON 接口不受影响） | `/` |
| `chainId` | 期望的链 ID（如 1 = 主网）；不配则取多数节点为准 | 自动检测 |
| `health.pollIntervalMs` | 健康轮询间隔 | 5000 |
| `health.maxBlockLag` | 落后池内最大高度多少块算掉队 | 5 |
| `health.failureThreshold` | 连续失败多少次摘除 | 3 |
| `health.maxRetries` | 单请求最多尝试几个上游 | 2 |
| `health.retryBaseDelayMs` / `retryMaxDelayMs` | 重试指数退避：`base * 2^(n-1)`，封顶 max | 100 / 1000 |
| `health.wsHeads` | 通过持久的 `eth_subscribe("newHeads")` WS 连接跟踪链高（WS 断开时回退 HTTP 轮询）；`false` = 仅 HTTP 轮询 + 每轮探测 WS 可用性 | true |
| `health.wsPingIntervalMs` | 上游 WS 连接的客户端保活 ping 间隔；连续两个间隔无 pong 判定死链并断开重连。防止服务商网关空闲断连（close 1006）；`0` 关闭 | 30000 |
| `reorg.enabled` / `reorg.windowSize` | 基于上游 newHeads 的重组检测：校验 parentHash 与滑动区块头窗口的连续性，跨上游仲裁（冲突分支被后续块接续或被第二个上游证实才判定）；确认的重组记录日志、计入指标（`ethproxy_reorgs_detected_total`、`ethproxy_reorg_depth`）并经 `pool.onReorg` 广播。依赖 `health.wsHeads` | true / 128 |
| `filters.stickyTtlMs` | filter 粘滞路由映射的空闲 TTL，每次轮询刷新 | 300000 |
| `txpool.mirror` | 本地 pending 交易镜像：池为每个 WS 可用的上游维持 `eth_subscribe("newPendingTransactions")` 订阅，客户端订阅改由代理本地应答（哈希去重后扇出）；`false` = 透传上游 | false |
| `syncing.mirror` | 本地应答 `eth_subscribe("syncing")`，按池聚合视图：任一上游同步中即返回 syncing（带进度对象），全部同步完回 false（订阅后立即回当前状态，之后只在变化时推送）；`false` = 透传上游 | false |
| `cache.backend` | `memory` 或 `redis` | `memory` |
| `cache.enabled` | 缓存总开关，`false` 时所有请求绕过缓存（也不再连接 Redis） | true |
| `cache.shortTtlMs` | 链头相关数据 TTL（dynamicTtl 开启时为上限/回退值） | 2000 |
| `cache.unfinalizedTtlMs` | 7 个重组校验方法未定型条目的兜底 TTL（正确性由读时重组校验保证） | 900000 |
| `cache.dynamicTtl` | 按观测出块间隔动态调整短 TTL（间隔/4，钳制在 `[minTtlMs, shortTtlMs]`） | true |
| `cache.finalityDepth` | 多少块深度视为不可变 | 64 |
| `cache.redis.url` / `keyPrefix` | Redis 连接与键前缀 | — |
| `security.blockedNamespaces` | 直接拒绝的 RPC 命名空间 | admin, personal, debug, trace, miner, txpool |
| `security.maxBatchSize` / `maxBodyBytes` / `maxLogsRange` | 批量大小、请求体、`eth_getLogs` 跨度上限 | 100 / 1MB / 10000 |
| `rateLimit.enabled` | 按客户端 IP 限速总开关（HTTP 429 / WS 返回 -32005） | true |
| `rateLimit.requestsPerSecond` / `burst` | HTTP 限速速率与突发容量（批量按元素计费） | 50 / 100 |
| `rateLimit.wsMessagesPerSecond` / `wsBurst` | WS 消息限速速率与突发容量 | 20 / 40 |
| `rateLimit.maxSubscriptionsPerIp` | 同一 IP 并发订阅数上限（跨连接合计，退订/断连释放） | 20 |
| `cors.enabled` / `cors.origin` | 跨域配置；`*` 允许任意域，多个域逗号分隔 | true / `*` |

## 缓存策略细节

判定逻辑在 [`src/cache-rules.ts`](src/cache-rules.ts)：`requestPolicy(method, params, ctx)` 在请求阶段决定能否缓存，`responseTtl()` 依据响应内容修正（例如 `eth_getTransactionReceipt` 只有含 `blockHash` 才永久缓存，`null` 只给极短 TTL）。缓存键为 `method + sha256(规范化 params)`，下述 7 个重组校验方法除外。

**重组校验条目**（`eth_getBlockByNumber`、`eth_getBlockTransactionCountByNumber`、`eth_getTransactionByBlockNumberAndIndex`、`eth_getUncleByBlockNumberAndIndex`、`eth_getUncleCountByBlockNumber`、`eth_getTransactionByHash`、`eth_getTransactionReceipt`）：这些方法使用明文 key——`方法名:规范化参数`，数量型参数统一为小写最小十六进制——外部系统可直接构造 key 查询或失效条目。低于 `cache.finalityDepth` 的条目以 `cache.unfinalizedTtlMs` 存储（而非短 TTL），并盖有写入时观测到的规范块哈希戳；每次读取时与重组检测器的区块头窗口比对，被重组的条目在下一次读取时变为 miss（并被删除）——失效由重组检测驱动而非 TTL。无法校验的条目（窗口断缝、检测关闭）退化为纯 TTL 语义。依赖 `health.wsHeads` 与 `reorg.enabled`；`reorg.windowSize` 必须 ≥ `cache.finalityDepth`（配置加载时强制校验）。

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

- WebSocket 订阅的断线自动重订阅（上游订阅连接断开时客户端连接随之关闭，重连重订阅由客户端负责）
- 鉴权
