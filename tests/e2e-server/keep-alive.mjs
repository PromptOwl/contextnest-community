// @ts-check

/**
 * Loaded into the server under test before its own code (NODE_OPTIONS
 * --import, see lib.mjs). Test-only.
 *
 * Node closes a kept-alive connection that has been idle for 5 seconds. The
 * suites' API helpers keep connections open and reuse them, and a spec often
 * spends longer than that in the browser between two API calls. When the next
 * call goes out on a connection the server is closing at that moment, it fails
 * with `read ECONNRESET` (seen on CN-COLLAB-008, PO-1388). A deployed server
 * sits behind a proxy that holds the client's connection, so this happens only
 * here. Idle connections are kept for longer than any spec waits.
 */

import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

export const KEEP_ALIVE_MS = 120_000;

const createServer = http.createServer;
// @ts-ignore — same arguments, passed through untouched.
http.createServer = function createServerKeptAlive(...args) {
  // @ts-ignore
  const server = createServer.apply(this, args);
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  return server;
};
// So `import { createServer } from 'node:http'` gets it too.
syncBuiltinESMExports();
