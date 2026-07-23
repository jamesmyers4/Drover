import { describe, expect, it } from "vitest";
import { computeMatchKey, normalizeRoute } from "../../src/matching/match-key.js";

describe("normalizeRoute", () => {
  it("strips origin, query, and hash from a plain URL", () => {
    expect(normalizeRoute("https://staging.example.test/schedule/edit?x=1#top")).toBe(
      "/schedule/edit",
    );
  });

  it("extracts the URL embedded in an http-failure observation target", () => {
    expect(normalizeRoute("500 GET http://127.0.0.1:4000/api/horses/page2?x=1")).toBe(
      "/api/horses/page2",
    );
    expect(normalizeRoute("FAILED GET http://127.0.0.1:4000/api/horses/page2")).toBe(
      "/api/horses/page2",
    );
  });

  it("passes through a non-URL target (e.g. a CSS selector) unchanged", () => {
    expect(normalizeRoute("#does-not-exist")).toBe("#does-not-exist");
  });
});

describe("computeMatchKey", () => {
  it("is stable across different hosts for the same route (cross-run, cross-environment)", () => {
    const a = computeMatchKey("console-error", "http://localhost:3000/broken");
    const b = computeMatchKey("console-error", "https://staging.example.test/broken?x=1");
    expect(a).toBe(b);
  });

  it("distinguishes routes and finding types", () => {
    expect(computeMatchKey("console-error", "http://h/a")).not.toBe(
      computeMatchKey("console-error", "http://h/b"),
    );
    expect(computeMatchKey("console-error", "http://h/a")).not.toBe(
      computeMatchKey("http-failure", "http://h/a"),
    );
  });

  it("suffixes the embedded HTTP method so GET and POST to the same route don't collide", () => {
    const get = computeMatchKey("http-failure", "500 GET http://h/api/schedule");
    const post = computeMatchKey("http-failure", "500 POST http://h/api/schedule");
    expect(get).not.toBe(post);
  });

  it("accepts an explicit target identifier as a suffix", () => {
    expect(computeMatchKey("hard-stop", "http://h/signup", "click:#submit")).toBe(
      "hard-stop:/signup:click:#submit",
    );
  });
});
