/**
 * Standalone target app for the toy example — a tiny, dependency-free HTTP
 * server with a horse-browsing bug and a volunteer signup flow, so
 * `examples/toy-app/domain-pack.ts` has something real to run against
 * without needing Horse Haven staging or any network access.
 *
 * Deliberately separate from `tests/fixtures/site.ts` (which serves the
 * *test suite's* needs — console errors, page exceptions, a login wall) even
 * though the pattern is identical: this one is part of the shipped example a
 * new adopter runs and reads, not internal test infrastructure, and it binds
 * to a fixed, predictable port so `sim.config.ts` can hardcode a URL instead
 * of needing the two processes to coordinate an ephemeral one.
 *
 * Run standalone: `npx tsx examples/toy-app/site-server.ts`
 * Override the port: `PORT=5000 npx tsx examples/toy-app/site-server.ts`
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 4173;

const pages: Record<string, { status: number; contentType: string; body: string }> = {
  "/": {
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Paddock Pals</title></head><body>
      <h1>Paddock Pals Volunteer Portal</h1>
      <nav>
        <a href="/horses" id="nav-horses">Browse horses</a>
        <a href="/signup" id="nav-signup">Volunteer signup</a>
      </nav>
    </body></html>`,
  },
  "/horses": {
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Our Horses</title></head><body>
      <h1>Our Horses</h1>
      <ul><li>Biscuit</li><li>Clover</li><li>Domino</li></ul>
      <button id="load-more" onclick="fetch('/api/horses/more')">Load more</button>
      <a href="/">Home</a>
    </body></html>`,
  },
  "/signup": {
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Volunteer Signup</title></head><body>
      <h1>Volunteer signup</h1>
      <form action="/signup/thanks" method="get">
        <label>Name <input type="text" name="name" id="signup-name"></label>
        <label>Email <input type="email" name="email" id="signup-email"></label>
        <button type="submit" id="signup-submit">Sign up</button>
      </form>
    </body></html>`,
  },
  "/signup/thanks": {
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Thanks</title></head><body>
      <h1>Thanks for signing up!</h1>
      <p>A coordinator will reach out about your first shift.</p>
      <a href="/">Home</a>
    </body></html>`,
  },
  // Intentional bug: this always 500s. A persona that clicks "Load more" on
  // /horses surfaces it as a real in-session http-failure finding — the
  // whole point of a toy example is to demonstrate Drover actually catching
  // something, not just complete a scripted happy path.
  "/api/horses/more": {
    status: 500,
    contentType: "application/json",
    body: '{"error":"failed to load additional horses"}',
  },
};

export function startToyAppServer(
  port = DEFAULT_PORT,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const page = pages[url.pathname];
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(page.status, { "content-type": page.contentType });
    res.end(page.body);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actualPort = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${actualPort}`,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

async function main(): Promise<void> {
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  const { baseUrl } = await startToyAppServer(port);
  console.log(`Toy example app listening at ${baseUrl}`);
  console.log("Press Ctrl+C to stop.");
}

// Only auto-start when run directly (`tsx examples/toy-app/site-server.ts`),
// not when imported by a test that wants to control its own lifecycle.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
