import { App, ProxyMiddleware } from "./core";
import * as eth from './eth';
import { Cache } from 'cache-manager'
function cacheBlock(cache: Cache, block: eth.Block, full: boolean) {
  const k1 = `block/${block.number}${full ? '+' : ''}`
  const k2 = `block/${block.hash}${full ? '+' : ''}`
  cache.set(k1, block);
  cache.set(k2, block);
  return block;
}
const methods: Record<string, ProxyMiddleware> = {
  async eth_blockNumber(ctx: App, params: any[], request) {
    const originData = await request()
    return originData
  },

  async eth_getBlockByNumber(ctx: App, params: any[], request) {
    const id: string | number = params[0]
    const full: boolean = params[1]
    if (id === 'latest' || id === 'earliest' || id === 'pending') {
      const block = await request();
      return cacheBlock(ctx.cache, block, full)

    } else {
      return ctx.cache.wrap(`block/${id}${full ? '+' : ''}`, request);
    }
  },
  async eth_getBlockByHash(ctx: App, params: any[], request) {
    const hash: string | number = params[0]
    const full: boolean = params[1]
    if (hash === 'latest' || hash === 'earliest' || hash === 'pending') {
      const block = await request();
      return cacheBlock(ctx.cache, block, full)
    } else {
      return ctx.cache.wrap(`block/${hash}${full ? '+' : ''}`, request);
    }
  }
}

export default methods;
