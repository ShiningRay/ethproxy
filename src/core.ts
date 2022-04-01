import Server from './server';
import { Cache, CacheOptions, StoreConfig } from "cache-manager";
import Fastify, { FastifyInstance, RouteShorthandOptions } from 'fastify'

export interface JSONRPCRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params: any[];
}

export interface ServerDefinition {
  name: string;
  url: string;
}

export enum State {
  pending,
  active,
  down
}

export interface ConfigDefition {
  nginx: {
    pidPath: string;
    upstreamPath: string;
    upstreamName: string;
  }
  telegram?: {
    botToken?: string;
  }
  servers: ServerDefinition[];
  checkInterval: number;
  cache: StoreConfig & CacheOptions;
}

export interface App {
  tipBlockHeight: number;
  servers: Server[];
  primaryServer?: Server;
  proxyServer?: FastifyInstance
  selectAvailableServer(): Server | undefined;
  cache: Cache;
}

export type ProxyMiddleware = (app: App, params: any[], request: (newParams?: any[]) => Promise<any>) => any;
