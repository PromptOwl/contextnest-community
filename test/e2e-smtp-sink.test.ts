import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { startSmtpSink } from "../tests/e2e-server/smtp-sink.mjs";

/** Send lines to the sink one reply at a time; returns every reply. */
function talk(port: number, sends: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const replies: string[] = [];
    const queue = [...sends];
    const socket = net.connect(port, "127.0.0.1");
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("data", (chunk: string) => {
      replies.push(chunk.trim());
      const next = queue.shift();
      if (next === undefined) socket.end();
      else socket.write(next);
    });
    socket.on("close", () => resolve(replies));
  });
}

describe("e2e mail sink (accepts every message, delivers none)", () => {
  let server: net.Server | undefined;
  afterEach(() => server?.close());

  const listen = async (onMessage?: (n: number) => void) => {
    server = await startSmtpSink(0, onMessage);
    return (server.address() as net.AddressInfo).port;
  };

  it("accepts a message and counts it", async () => {
    const counts: number[] = [];
    const port = await listen((n) => counts.push(n));
    const replies = await talk(port, [
      "EHLO client\r\n",
      "MAIL FROM:<a@example.com>\r\n",
      "RCPT TO:<b@example.com>\r\n",
      "DATA\r\n",
      "Subject: hello\r\n\r\nA line.\r\n.\r\n",
      "QUIT\r\n",
    ]);
    expect(replies[0]).toMatch(/^220 /);
    expect(replies[1]).toMatch(/^250-.*\r?\n250 /s);
    expect(replies[4]).toMatch(/^354 /);
    expect(replies[5]).toMatch(/^250 .*discarded/);
    expect(replies[6]).toMatch(/^221 /);
    expect(counts).toEqual([1]);
  });

  it("takes several messages on one connection, as a pooled client sends them", async () => {
    const counts: number[] = [];
    const port = await listen((n) => counts.push(n));
    const one = ["MAIL FROM:<a@example.com>\r\n", "RCPT TO:<b@example.com>\r\n", "DATA\r\n", "Body\r\n.\r\n"];
    await talk(port, ["EHLO client\r\n", ...one, "RSET\r\n", ...one, "QUIT\r\n"]);
    expect(counts).toEqual([1, 2]);
  });

  it("does not offer TLS or sign-in, and refuses verbs it doesn't know", async () => {
    const port = await listen();
    const replies = await talk(port, ["EHLO client\r\n", "STARTTLS\r\n", "QUIT\r\n"]);
    expect(replies[1]).not.toMatch(/STARTTLS|AUTH/);
    expect(replies[2]).toMatch(/^502 /);
  });
});
