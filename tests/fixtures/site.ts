/**
 * Tiny local fixture site for tests and the smoke script — no network
 * dependency, deterministic content. Serves a few pages that exercise the
 * harness: navigation links, a form, a console error, an uncaught page
 * exception, an HTTP 500, and a login page (password field) for auth-wall
 * detection.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const pages: Record<string, { status: number; contentType: string; body: string }> = {
  "/": {
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Fixture Home</title></head><body>
      <h1>Fixture Home</h1>
      <nav>
        <a href="/horses" id="nav-horses">Browse horses</a>
        <a href="/signup" id="nav-signup">Volunteer signup</a>
        <a href="/login" id="nav-login">Log in</a>
      </nav>
    </body></html>`,
  },
  "/horses": {
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Horses</title></head><body>
      <h1>Our Horses</h1>
      <ul><li>Biscuit</li><li>Clover</li><li>Domino</li></ul>
      <button id="load-more" onclick="fetch('/api/horses/page2')">Load more</button>
      <a href="/">Home</a>
    </body></html>`,
  },
  "/signup": {
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Signup</title></head><body>
      <h1>Volunteer signup</h1>
      <form action="/signup" method="get">
        <label>Name <input type="text" name="name" id="signup-name"></label>
        <label>Email <input type="email" name="email" id="signup-email"></label>
        <button type="submit" id="signup-submit">Sign up</button>
      </form>
    </body></html>`,
  },
  "/login": {
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Log in</title></head><body>
      <h1>Log in</h1>
      <form action="/dashboard" method="get">
        <input type="text" name="user" id="login-user">
        <input type="password" name="pass" id="login-pass">
        <button type="submit">Log in</button>
      </form>
    </body></html>`,
  },
  "/dashboard": {
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Dashboard</title></head><body>
      <h1 id="dashboard-heading">Volunteer dashboard</h1>
      <a href="/">Home</a>
    </body></html>`,
  },
  "/broken": {
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Broken</title></head><body>
      <h1>Broken page</h1>
      <script>console.error("fixture console error: widget failed to mount");</script>
    </body></html>`,
  },
  "/api/horses/page2": {
    status: 500,
    contentType: "application/json",
    body: '{"error":"fixture internal error"}',
  },
  "/throws": {
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Throws</title></head><body>
      <h1>Uncaught exception page</h1>
      <script>null.foo();</script>
    </body></html>`,
  },
  "/async-redirect": {
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><html><head><title>Async redirect</title></head><body>
      <h1>Async redirect</h1>
      <button id="submit" onclick="fetch('/api/slow-action').then(() => history.pushState(null, '', '/async-redirect?result=done'))">Submit</button>
    </body></html>`,
  },
  "/api/slow-action": {
    status: 200,
    contentType: "application/json",
    body: '{"ok":true}',
  },
};

/** Server-side delay (ms) before /api/slow-action responds — simulates a
 * Server-Action-style fetch that resolves after the click primitive itself
 * has already returned. */
const SLOW_ACTION_DELAY_MS = 300;

export interface FixtureSite {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startFixtureSite(): Promise<FixtureSite> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const page = pages[url.pathname];
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const respond = () => {
      res.writeHead(page.status, { "content-type": page.contentType });
      res.end(page.body);
    };
    if (url.pathname === "/api/slow-action") {
      setTimeout(respond, SLOW_ACTION_DELAY_MS);
    } else {
      respond();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
