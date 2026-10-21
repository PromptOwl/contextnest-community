/** Host names are case-insensitive: a capitalised Host with a port must not 400. */
import { describe, it, expect, afterAll } from "vitest";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { lowercaseHostServer } from "../src/shared/http-server.js";

const app = new Hono().get("/", (c) => c.text(new URL(c.req.url).host));
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", createServer: lowercaseHostServer });
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const get = (host: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const req = request({ host: "127.0.0.1", port, path: "/", headers: { Host: host } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });

describe("lowercaseHostServer", () => {
  it.each(["DOCS.Example.com:443", "Example.com:80", "LOCALHOST:3838", "docs.example.com:443", "Docs.Example.com"])(
    "answers Host %s",
    async (host) => {
      const res = await get(host);
      expect(res.status).toBe(200);
      expect(res.body).toBe(new URL(`http://${host.toLowerCase()}`).host);
    },
  );
});
