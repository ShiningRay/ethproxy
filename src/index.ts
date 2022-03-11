import { includes, map, pull } from "lodash";
import { JsonRpc, JsonRpcResult } from "node-jsonrpc-client";
import { readFileSync, writeFile, writeFileSync } from 'fs';
import * as fs from 'fs';
import TelegramBot from "node-telegram-bot-api";

interface ServerDefinition {
  name: string;
  url: string;
}

enum State {
  pending,
  active,
  down
}

function findMax(arr: Server[]) {
  const arr2 = arr.sort((a, b) => (b.blockHeight || 0) - (a.blockHeight || 0));
  const fastServers = [arr2[0]]
  const max = arr2[0].blockHeight;
  for (let i = 1; i < arr2.length; i++) {
    if (arr2[i].blockHeight === max) {
      fastServers.push(arr2[i]);
    } else {
      break;
    }
  }
  return fastServers;
}

class Server {
  public readonly config: ServerDefinition;
  public state: State = State.pending;
  private client: JsonRpc;
  private _blockHeight?: number;

  constructor(config: ServerDefinition) {
    this.config = config;
    this.client = new JsonRpc(config.url);
  }

  // return the block height last fetched
  public get blockHeight() {
    return this._blockHeight;
  }

  public get url() {
    return this.config.url;
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

interface ConfigDefition {
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
}

class TelegramAlertBot {
  private bot;
  private chatIds: Set<number> = new Set();
  private chatIdsPath = '/tmp/chatIds';
  constructor(token: string) {
    this.bot = new TelegramBot(token, { polling: true })

    if (fs.existsSync(this.chatIdsPath)) {
      const ids = readFileSync(this.chatIdsPath).toString().split(',')
      for (const id of ids) {
        this.chatIds.add(parseInt(id));
      }
    }
    console.log(this.chatIds)
    this.bot.onText(/\/monitor/, (msg) => {
      console.log('received bot instruction')
      this.addChatId(msg.chat.id);
      this.bot.sendMessage(msg.chat.id, "ready to send alert of godwoken nodes");
    })

    this.bot.onText(/\/stop/, (msg) => {
      this.removeChatId(msg.chat.id);
      this.bot.sendMessage(msg.chat.id, "stop sending alert of godwoken nodes");
    })
  }

  private addChatId(id: number) {
    this.chatIds.add(id);
    console.log(this.chatIds)
    writeFileSync(this.chatIdsPath, Array.from(this.chatIds).join(','));
  }

  private removeChatId(id: number) {
    this.chatIds.delete(id);
    console.log(this.chatIds)
    writeFileSync(this.chatIdsPath, Array.from(this.chatIds).join(','));
  }

  async send(message: string) {
    const promises = []
    for (let id of this.chatIds) {
      promises.push(this.bot.sendMessage(id, message))
    }
    return Promise.all(promises);
  }
}

class Monitor {
  public tipBlockHeight: number = 0;
  private checkTimer?: NodeJS.Timeout;
  private servers: Server[] = [];
  private primaryServer?: Server;
  private bot?: TelegramAlertBot;

  constructor(private config: ConfigDefition) {
    this.servers = config.servers.map(s => new Server(s));
    if (config.telegram && config.telegram.botToken) {
      this.bot = new TelegramAlertBot(config.telegram.botToken);
    }
  }

  public async start() {
    await this.checkVersions();
    await this.check();
  }

  // perform a check against all backend servers.
  // using the fastest server, which returns max block number, as primary server.
  // if no available server found, then issue alert.
  public async check() {
    // Parallelize the check tasks
    const tasks = this.servers.map(s => {
      return s.getBlockHeight().catch(e => {
        s.state = State.down;
        const msg = `${s.name} ${s.url} is down: ${e.message}`;
        console.error(msg);
        this.bot?.send(msg);
      });
    });
    await Promise.all(tasks);

    const availableServers = this.servers.filter(s => s.state === State.active)

    // there would be sereval servers with the same block height.
    const maxServers = findMax(availableServers);
    // if last primary server is included in these servers, then don't change primary server.
    if (!includes(maxServers, this.primaryServer)) {
      this.primaryServer = maxServers[0];
      this.generateNginxUpstreams();
    }
    this.checkTimer = setTimeout(() => {
      this.check();
    }, this.config.checkInterval || 5000);
  }

  // check if all servers are connected to the same network.
  // if not same, then exit program.
  // otherwise the request will be inconsistent.
  public async checkVersions() {
    let version: (string | undefined);
    for (let s of this.servers) {
      try {
        const v = await s.getNetVersion();
        console.log(s.name, s.url, 'net_version: ', v)
        if (!version) {
          version = v
        } else {
          if (version !== v) {
            throw new Error(`Inconsistent versions: ${version} vs ${v}`);
          }
        }
      } catch (err) {
        console.log(err)
        pull(this.servers, s)
      }
    }
  }


  public generateNginxUpstreams() {
    const serverList = this.servers.map(server =>
      `server ${server.url} ${this.primaryServer === server ? '' : 'down'};`
    ).join('\n');
    const content = `upstream ${this.config.nginx.upstreamName} {
      ${serverList}
    }`;

    writeFileSync(this.config.nginx.upstreamPath, content);
    const nginxPid = parseInt(readFileSync(this.config.nginx.pidPath).toString());
    if (!isNaN(nginxPid)) {
      console.log('reloading nginx')
      process.kill(nginxPid, 'SIGHUP')
    }
  }
}


const mon = new Monitor(require(__dirname + '/../config.js'));
mon.start()
