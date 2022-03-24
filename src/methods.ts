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
    const cacheKey = `block/${blockHash}/tx/${index}`;
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
      ctx.cache.set(`block/${tx.hash}/tx/${tx.transactionIndex}`, tx);
    }
    return tx;
  },

  async eth_getTransactionByBlockNumberAndIndex(ctx: App, params: any[], request) {
    const blockHash: string = params[0];
    const index: string = params[1];
    const cacheKey = `block/${blockHash}/tx/${index}`;
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
    const cacheKey = `tx/${hash}/receipt`;
    return ctx.cache.wrap(cacheKey, request);
  },

  async eth_getUncleCountByBlockNumber(ctx: App, params: any[], request) {
    const blockNumber: string = params[0];
    if (blockNumber === 'latest' || blockNumber === 'earliest' || blockNumber === 'pending') {
      return request();
    } else {
      return ctx.cache.wrap(`block/${blockNumber}/uncleCount`, request);
    }
  },

  async eth_getUncleCountByBlockHash(ctx: App, params: any[], request) {
    const blockNumber: string = params[0];
    if (blockNumber === 'latest' || blockNumber === 'earliest' || blockNumber === 'pending') {
      return request();
    } else {
      return ctx.cache.wrap(`block/${blockNumber}/uncleCount`, request);
    }
  },

  async eth_getBlockTransactionCountByNumber(ctx: App, params: any[], request) {
    const blockNumber: string = params[0];
    if (blockNumber === 'latest' || blockNumber === 'earliest' || blockNumber === 'pending') {
      return request();
    } else {
      return ctx.cache.wrap(`block/${blockNumber}/txCount`, request);
    }
  },

  async eth_getBlockTransactionCountByHash(ctx: App, params: any[], request) {
    const blockNumber: string = params[0];
    if (blockNumber === 'latest' || blockNumber === 'earliest' || blockNumber === 'pending') {
      return request();
    } else {
      return ctx.cache.wrap(`block/${blockNumber}/txCount`, request);
    }
  },

  async eth_getTransactionCount(ctx: App, params: any[], request) {
    const address: string = params[0];
    const blockNumber: string = params[1];
    if (blockNumber === 'latest' || blockNumber === 'earliest' || blockNumber === 'pending') {
      return request();
    } else {
      return ctx.cache.wrap(`address/${address}/txCount@${blockNumber}`, request);
    }
  },

  async eth_getStorageAt(ctx: App, params: any[], request) {
    const address: string = params[0];
    const pos: string = params[1];
    const blockNumber: string = params[2];

    if (blockNumber === 'latest' || blockNumber === 'earliest' || blockNumber === 'pending') {
      return request();
    } else {
      return ctx.cache.wrap(`storage@${blockNumber}/${address}/${pos}`, request);
    }
  },

  async eth_getBalance(ctx: App, params: any[], request) {
    const address: string = params[0];
    const blockNumber: string = params[1];

    if (blockNumber === 'latest' || blockNumber === 'earliest' || blockNumber === 'pending') {
      return request();
    } else {
      return ctx.cache.wrap(`address/${address}/balance@${blockNumber}`, request);
    }
  },

  // we don't support eth client accounts
  async eth_accounts(ctx: App, params: any[], request) {
    return [];
  },


  async eth_sign(ctx: App, params: any[], request) {
    throw new Error("We don't support client accounts and sign");
  },
  async eth_signTransaction(ctx: App, params: any[], request) {
    throw new Error("We don't support client accounts and sign");
  },
  async eth_sendTransaction(ctx: App, params: any[], request) {
    throw new Error("We don't support client accounts and sign");
  },

  async eth_getLogs(ctx: App, params: any[], request) {
    const q: eth.GetLogParams = params[0]
    let h: string | undefined = undefined;
    if (!q.fromBlock) {
      q.fromBlock = '0x' + ctx.tipBlockHeight.toString(16);
      h = q.fromBlock
    }

    if (!q.toBlock) {
      q.toBlock = h || ('0x' + ctx.tipBlockHeight.toString(16))
    }
    const address: string[] = q.address ? (typeof q.address === 'string' ? [q.address] : q.address) : [];
    const topics: string = q.topics ? q.topics.join(',') : ''
    return ctx.cache.wrap(`logs/${q.fromBlock}-${q.toBlock}?${address.join(',')}&${topics}`, () => request([q]));
  }
}

export default methods;
