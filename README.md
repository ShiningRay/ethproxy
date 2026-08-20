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
- **批量请求**：数组请求逐项走缓存管线，未命中项合并为单次批量转发后按 id 归并
- **运维端点**：`GET /healthz`（无健康上游返回 503）、`GET /status`（各节点健康/同步/高度）

## 快速开始

```bash
npm install
cp config.example.yaml config.yaml   # 按实际节点修改 upstreams
npm run dev -- config.yaml           # 开发模式
# 或
npm run build && npm start -- config.yaml
```

客户端把节点地址指向 `http://127.0.0.1:8545` 即可。

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
| `cache.backend` | `memory` 或 `redis` | `memory` |
| `cache.shortTtlMs` | 链头相关数据 TTL | 2000 |
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

## 开发

```bash
npm test          # vitest（单元 + 集成，mock upstream）
npm run typecheck # tsc --noEmit
```

## 范围外（暂未实现）

- WebSocket / `eth_subscribe`
- 请求限流、鉴权
