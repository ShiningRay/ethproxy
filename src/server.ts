import { JsonRpc, JsonRpcResult } from "node-jsonrpc-client";
import { ServerDefinition, State } from "./core";


export default class Server {
  public readonly config: ServerDefinition;
  public state: State = State.pending;
  private client: JsonRpc;
  private _blockHeight?: number;
  private _url: URL;

  constructor(config: ServerDefinition) {
    this.config = config;
    this._url = new URL(this.config.url);
    this.client = new JsonRpc(config.url);
  }

  // return the block height last fetched
  public get blockHeight() {
    return this._blockHeight;
  }

  public get url() {
    return this.config.url;
  }

  public get host() {
    return this._url.host;
  }
  public get hostname() {
    return this._url.hostname;
  }
  public get port() {
    return this._url.port;
  }

  public get name() {
    return this.config.name;
  }

  public async getNetVersion() {
    const result: JsonRpcResult<string> = await this.client.call<[], string>('net_version', []);
    return result.result;
  }

  // get block height from backend server. and store the blockheight to instance variable
  public async getBlockHeight() {
    const result: JsonRpcResult<string> = await this.client.call<[], string>('eth_blockNumber', []);
    if (result.result) {
      this._blockHeight = parseInt(result.result, 16);
      console.log(this.name, this.url, 'block height: ', this._blockHeight)
      this.state = State.active;
    }
    return this._blockHeight;
  }
}
