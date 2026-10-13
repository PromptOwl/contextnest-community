/**
 * The server (Network & status) and the UI (Connect modal) each carry an
 * isPrivateHost — the UI doesn't import server code. They must agree.
 */
import { describe, it, expect } from "vitest";
import { isPrivateHost as server } from "../src/shared/private-host.js";
import { isPrivateHost as ui } from "../ui/src/lib/connect.js";

const CASES = [
  "http://localhost:3838",
  "https://app.localhost",
  "http://nestbox",
  "https://nest.corp",
  "https://nest.internal",
  "https://nest.home.arpa",
  "http://10.1.2.3",
  "http://172.16.0.1",
  "http://172.32.0.1",
  "http://192.168.1.10",
  "http://169.254.1.1",
  "http://100.64.0.1",
  "http://100.128.0.1",
  "http://[::1]:3838",
  "http://[fd12:3456::1]",
  "https://nest.example.com",
  "https://8.8.8.8",
  "not a url",
];

describe("isPrivateHost parity", () => {
  it.each(CASES)("%s", (url) => {
    expect(server(url)).toBe(ui(url));
  });
});
