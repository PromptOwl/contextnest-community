/**
 * `createServer` for @hono/node-server that lower-cases the Host header first.
 *
 * node-server 1.x (through 1.19.17) compares the URL's lower-cased hostname
 * with the raw Host header when a port is present, so `Host: Docs.Example.com:443`
 * gets a bare 400 before any route runs. Host names are case-insensitive
 * (RFC 9110 §4.2.3); 2.x fixed the compare. Drop this when we move to 2.x.
 */
import { createServer, type IncomingMessage, type RequestListener, type ServerOptions } from "node:http";

export const lowercaseHostServer = ((options: ServerOptions, listener?: RequestListener) =>
  createServer(options, (req: IncomingMessage, res) => {
    if (req.headers.host) req.headers.host = req.headers.host.toLowerCase();
    listener?.(req, res);
  })) as typeof createServer;
