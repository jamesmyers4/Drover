/**
 * Standalone target app for the Soak mode toy example (CTS.md Soak Session
 * 8) — a tiny, dependency-free JSON API with a backbone endpoint that fails
 * periodically and a metered endpoint with a simulated per-period cap, so
 * `examples/soak-toy-fixture/blueprint.ts` has something real to run
 * against. Mirrors `examples/toy-app/site-server.ts`'s role for the
 * simulation stack — same fixed-port convention, same
 * exported-start-function-plus-standalone-main shape — but a small JSON API
 * instead of static HTML, since Soak mode drives a target over direct API
 * calls, not a browser (ADR 0006).
 *
 * Two intentional, deterministic (not random) behaviors, so a small
 * reference run reliably demonstrates both without needing a large sample:
 * - `POST /api/entries` (backbone, uncapped) fails with a 500 every 5th
 *   call — same "the whole point is to demonstrate Drover actually catching
 *   something" precedent `examples/toy-app`'s `/api/horses/more` already set.
 * - `POST /api/message-analysis` (metered pipeline) simulates a real
 *   target's own per-period usage cap: the first `MESSAGE_ANALYSIS_CAP`
 *   calls succeed, every call after that gets a real 429 — proving ADR
 *   0006's "402/429 is expected gating, not an error" distinction end to
 *   end against an actual target response, not a mocked one.
 *
 * Run standalone: `npx tsx examples/soak-toy-fixture/site-server.ts`
 * Override the port: `PORT=5000 npx tsx examples/soak-toy-fixture/site-server.ts`
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 4611;

/** Every Nth `/api/entries` call fails — deterministic, not probabilistic, so a small run reliably hits it. */
const ENTRY_FAILURE_EVERY_N = 5;
/** `/api/message-analysis` calls beyond this many (per process lifetime) get a real 429. */
const MESSAGE_ANALYSIS_CAP = 5;

export interface SoakToyFixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

export function startSoakToyFixtureServer(port = DEFAULT_PORT): Promise<SoakToyFixtureServer> {
  let entryCount = 0;
  let messageAnalysisCount = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const respond = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (req.method === "POST" && url.pathname === "/api/entries") {
        entryCount++;
        if (entryCount % ENTRY_FAILURE_EVERY_N === 0) {
          respond(500, { error: "internal error processing entry", entryCount });
          return;
        }
        respond(200, { ok: true, entryId: entryCount });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/message-analysis") {
        messageAnalysisCount++;
        if (messageAnalysisCount > MESSAGE_ANALYSIS_CAP) {
          respond(429, { error: "rate limited — simulated per-period cap exceeded" });
          return;
        }
        respond(200, { ok: true, toneEval: "neutral", callNumber: messageAnalysisCount });
        return;
      }

      respond(404, { error: "not found" });
    });
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
  const { baseUrl } = await startSoakToyFixtureServer(port);
  console.log(`Soak toy fixture app listening at ${baseUrl}`);
  console.log("Press Ctrl+C to stop.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
