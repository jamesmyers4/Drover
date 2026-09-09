import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVarySystemPrompt, buildVaryUserPrompt } from "../../src/soak/content-prompt.js";
import {
  createSoakContentProvider,
  DEFAULT_SOAK_OLLAMA_BASE_URL,
  MalformedVariationError,
  OllamaSoakContentProvider,
  ScriptedSoakContentProvider,
} from "../../src/soak/content-provider.js";

describe("buildVarySystemPrompt / buildVaryUserPrompt", () => {
  it("includes the example text verbatim in the user prompt", () => {
    expect(buildVaryUserPrompt("Had a calm day.")).toContain("Had a calm day.");
  });

  it("instructs the driver not to invent new content", () => {
    expect(buildVarySystemPrompt(undefined)).toMatch(/must NOT invent new scenarios/);
  });

  it("describes a configured wordSubstitutionRate as a percentage", () => {
    const prompt = buildVarySystemPrompt({ wordSubstitutionRate: 0.3 });
    expect(prompt).toContain("30%");
  });

  it("describes a configured targetLengthChars range", () => {
    const prompt = buildVarySystemPrompt({ targetLengthChars: { min: 50, max: 100 } });
    expect(prompt).toContain("50 and 100 characters");
  });

  it("defaults to keeping sentence order when allowDetailReordering is unset", () => {
    expect(buildVarySystemPrompt(undefined)).toMatch(
      /Keep sentences and details in their original order/,
    );
  });

  it("permits reordering when allowDetailReordering is true", () => {
    expect(buildVarySystemPrompt({ allowDetailReordering: true })).toMatch(
      /may reorder independent narrative details/,
    );
  });
});

describe("ScriptedSoakContentProvider", () => {
  it("replays varied text in order with zero cost", async () => {
    const provider = new ScriptedSoakContentProvider(["varied one", "varied two"]);

    const first = await provider.vary({ exampleText: "original" });
    const second = await provider.vary({ exampleText: "original" });

    expect(first.variedText).toBe("varied one");
    expect(second.variedText).toBe("varied two");
    expect(first.usage.costUsd).toBe(0);
  });

  it("throws once the script is exhausted", async () => {
    const provider = new ScriptedSoakContentProvider(["only one"]);
    await provider.vary({ exampleText: "original" });

    await expect(provider.vary({ exampleText: "original" })).rejects.toThrow(/script exhausted/);
  });
});

describe("OllamaSoakContentProvider", () => {
  function mockFetchOnce(status: number, jsonBody: unknown) {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(jsonBody),
      text: () => Promise.resolve(JSON.stringify(jsonBody)),
    });
    vi.stubGlobal("fetch", mockFetch);
    return mockFetch;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to the local Ollama server and posts to /api/chat", async () => {
    const mockFetch = mockFetchOnce(200, {
      message: {
        tool_calls: [{ function: { name: "vary_narrative", arguments: { variedText: "varied" } } }],
      },
      prompt_eval_count: 40,
      eval_count: 6,
    });
    const provider = new OllamaSoakContentProvider("llama3.1");

    await provider.vary({ exampleText: "Had a calm day." });

    expect(mockFetch).toHaveBeenCalledWith(
      `${DEFAULT_SOAK_OLLAMA_BASE_URL}/api/chat`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("parses a well-formed vary_narrative tool call with zero cost", async () => {
    mockFetchOnce(200, {
      message: {
        tool_calls: [
          {
            function: { name: "vary_narrative", arguments: { variedText: "It was a quiet day." } },
          },
        ],
      },
      prompt_eval_count: 100,
      eval_count: 10,
    });
    const provider = new OllamaSoakContentProvider("llama3.1");

    const result = await provider.vary({ exampleText: "Had a calm day." });

    expect(result.variedText).toBe("It was a quiet day.");
    expect(result.usage.costUsd).toBe(0);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(10);
  });

  it("throws MalformedVariationError when no tool call comes back", async () => {
    mockFetchOnce(200, { message: { content: "I decided not to call a tool" } });
    const provider = new OllamaSoakContentProvider("a-model-with-no-tool-support");

    await expect(provider.vary({ exampleText: "x" })).rejects.toBeInstanceOf(
      MalformedVariationError,
    );
  });

  it("throws MalformedVariationError when variedText is missing", async () => {
    mockFetchOnce(200, {
      message: { tool_calls: [{ function: { name: "vary_narrative", arguments: {} } }] },
    });
    const provider = new OllamaSoakContentProvider("llama3.1");

    const err = await provider.vary({ exampleText: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedVariationError);
    expect((err as Error).message).toMatch(/missing or empty 'variedText'/);
  });

  it("throws a plain Error when the Ollama server responds with a non-OK status", async () => {
    mockFetchOnce(500, { error: "model not found" });
    const provider = new OllamaSoakContentProvider("nonexistent-model");

    await expect(provider.vary({ exampleText: "x" })).rejects.toThrow(
      /Ollama request .* failed: 500/,
    );
  });

  it("respects an explicit baseUrl override", async () => {
    const mockFetch = mockFetchOnce(200, {
      message: {
        tool_calls: [{ function: { name: "vary_narrative", arguments: { variedText: "v" } } }],
      },
    });
    const provider = new OllamaSoakContentProvider("llama3.1", "http://remote-host:11434");

    await provider.vary({ exampleText: "x" });

    expect(mockFetch).toHaveBeenCalledWith("http://remote-host:11434/api/chat", expect.anything());
  });
});

describe("createSoakContentProvider", () => {
  it("builds an OllamaSoakContentProvider for driverProvider 'ollama'", () => {
    const provider = createSoakContentProvider({
      driverProvider: "ollama",
      driverModel: "llama3.1",
    });
    expect(provider).toBeInstanceOf(OllamaSoakContentProvider);
    expect(provider.model).toBe("llama3.1");
  });

  it("throws for an unsupported driverProvider", () => {
    expect(() =>
      createSoakContentProvider({ driverProvider: "anthropic", driverModel: "claude-haiku-4-5" }),
    ).toThrow(/Unsupported soak driver provider "anthropic"/);
  });
});
