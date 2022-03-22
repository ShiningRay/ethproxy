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
  },
  async eth_getTransactionByHash(ctx: App, params: any[], request) {
    const txHash: string = params[0];
    const cacheKey = `tx/${txHash}`;
    let tx: eth.Transaction | undefined = await ctx.cache.get(cacheKey);
    if (tx) {
      return tx;
    }
    tx = await request();
    if (!tx) {
      throw new Error('No such transaction');
    }
    // we don't store pending transactions
    if (tx.blockHash && tx.blockNumber && tx.transactionIndex) {
      ctx.cache.set(cacheKey, tx);
      ctx.cache.set(`tx/${tx.blockHash}#${tx.transactionIndex}`, tx);
    }
    return tx;
  },
  async eth_getTransactionByBlockHashAndIndex(ctx: App, params: any[], request) {
    const blockHash: string = params[0];
    const index: string = params[1];
    const cacheKey = `tx/${blockHash}#${index}`;
    let tx: eth.Transaction | undefined = await ctx.cache.get(cacheKey);
    if (tx) {
      return tx;
    }
    tx = await request();
    if (!tx) {
      throw new Error('No such transaction');
    }
    // we don't store pending transactions
    if (tx.blockHash && tx.blockNumber && tx.transactionIndex) {
      ctx.cache.set(cacheKey, tx);
      ctx.cache.set(`tx/${tx.hash}`, tx);
    }
    return tx;
  },

  // if transaction receipt is available, then the transaction must be committed to chain
  async eth_getTransactionReceipt(ctx: App, params: any[], request) {
    const hash: string = params[0]
    const cacheKey = `txReceipt/${hash}`;
    return ctx.cache.wrap(cacheKey, request);
  },
}

export default methods;
