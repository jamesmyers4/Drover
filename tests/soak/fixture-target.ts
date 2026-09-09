/**
 * Tiny local JSON-API fixture for scheduler tests — no network dependency,
 * deterministic content, mirrors `tests/fixtures/site.ts`'s own
 * dynamic-port/node:http style. Every path accepts the same `{ text }`
 * envelope `scheduler.ts` sends and inspects `text` for a marker substring
 * to deterministically force an error or a gating response, regardless of
 * which path it was posted to — one handler serves both the backbone and
 * metered-pipeline lanes' fixture needs.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const SOAK_FIXTURE_FORCE_ERROR_MARKER = "__FORCE_ERROR__";
export const SOAK_FIXTURE_FORCE_GATE_MARKER = "__FORCE_GATE__";

export interface SoakFixtureRequest {
  path: string;
  method: string;
  body: unknown;
  authorization: string | undefined;
}

export interface StartSoakFixtureTargetOptions {
  /** When set, every response includes this value via the `x-soak-cost-usd` header — lets a test exercise real-cost-header reading instead of the configured per-call estimate fallback. */
  costHeaderUsd?: number;
}

export interface SoakFixtureTarget {
  baseUrl: string;
  requests: SoakFixtureRequest[];
  close(): Promise<void>;
}

export async function startSoakFixtureTarget(
  options: StartSoakFixtureTargetOptions = {},
): Promise<SoakFixtureTarget> {
  const requests: SoakFixtureRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({
        path: req.url ?? "/",
        method: req.method ?? "GET",
        body,
        authorization: req.headers.authorization,
      });

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.costHeaderUsd !== undefined) {
        headers["x-soak-cost-usd"] = String(options.costHeaderUsd);
      }

      const text =
        typeof body === "object" && body !== null && "text" in body
          ? String((body as { text: unknown }).text)
          : "";

      if (text.includes(SOAK_FIXTURE_FORCE_ERROR_MARKER)) {
        res.writeHead(500, headers);
        res.end(JSON.stringify({ error: "fixture forced error" }));
        return;
      }
      if (text.includes(SOAK_FIXTURE_FORCE_GATE_MARKER)) {
        res.writeHead(429, headers);
        res.end(JSON.stringify({ error: "fixture forced gating" }));
        return;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, echo: text }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
