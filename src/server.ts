import Fastify, { FastifyInstance, RouteShorthandOptions } from 'fastify'
import { Server, IncomingMessage, ServerResponse } from 'http'
import { parse } from 'json-rpc-protocol'
const server: FastifyInstance = Fastify({ logger: true })
import axios from 'axios';
import * as path from 'path';
const config = require('../config.js');
server.post('/', async (req, rep) => {
  const s = config.servers[0].url;
  console.log(req.body);
  console.log(JSON.stringify(req.body));
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
