// @ts-check

/**
 * A mail server that accepts every message and throws it away.
 *
 * The server under test only writes its message log, and only shows the
 * mail-dependent parts of the UI, when it has somewhere to send mail. This
 * gives it somewhere, on 127.0.0.1, so no message ever leaves the machine.
 * It speaks just enough SMTP for the server's mail client: no TLS, no auth.
 */

import net from 'node:net';

/**
 * @param {number} port
 * @param {(count: number) => void} [onMessage] called after each accepted message
 * @returns {Promise<net.Server>}
 */
export function startSmtpSink(port, onMessage) {
  let accepted = 0;
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.write('220 e2e-sink ESMTP\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          // The message ends at a line holding a single dot.
          const end = buffer.startsWith('.\r\n') ? 0 : buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          buffer = buffer.slice(end === 0 ? 3 : end + 5);
          inData = false;
          accepted += 1;
          onMessage?.(accepted);
          socket.write('250 2.0.0 accepted and discarded\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') socket.write('250-e2e-sink\r\n250-8BITMIME\r\n250 SIZE 52428800\r\n');
        else if (verb === 'HELO') socket.write('250 e2e-sink\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (verb === 'QUIT') {
          socket.end('221 2.0.0 bye\r\n');
          return;
        } else if (['MAIL', 'RCPT', 'RSET', 'NOOP'].includes(verb)) socket.write('250 2.0.0 ok\r\n');
        else socket.write('502 5.5.1 not supported\r\n');
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
