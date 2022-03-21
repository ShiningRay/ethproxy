import Fastify, { FastifyInstance, RouteShorthandOptions } from 'fastify'
import { Server, IncomingMessage, ServerResponse } from 'http'
import { parse } from 'json-rpc-protocol'
const server: FastifyInstance = Fastify({ logger: true })
import axios from 'axios';
import * as path from 'path';
const config = require('../config.js');
interface JSONRPCRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params: any[];
}
server.post('/', async (req, rep) => {
  const s = config.servers[0].url;
  const { method, params } = req.body as JSONRPCRequest;
  const r = await axios.post(s, req.body)
  return r.data;
})


const start = async () => {
  try {
    await server.listen(process.env.PORT || 3000)
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
