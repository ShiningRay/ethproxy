import methods from '../src/methods'
import { Monitor } from '../src/index'
import { App } from '../src/core';
import * as cacheManager from 'cache-manager'
const NullApp: App = {
  tipBlockHeight: 10000,
  servers: [],
  selectAvailableServer() { return undefined },
  cache: cacheManager.caching({ store: 'memory', max: 100, ttl: 10/*seconds*/ })
}
let app: App
beforeEach(() => {
  app = NullApp;
})

test("eth_blockNumber", async () => {
  await expect(methods.eth_blockNumber(NullApp, [], async () => 10000)).resolves.toEqual(10000);
})

test("eth_getBlockByNumber", async () => {
  const block = {
    test: 'test'
  }
  await expect(methods.eth_getBlockByNumber(NullApp, [10000], async () => { return block })).resolves.toMatchObject(block);
})
