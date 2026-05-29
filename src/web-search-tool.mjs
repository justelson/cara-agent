import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 8;

export const ZYRA_WEB_SEARCH_TOOL_NAME = "web_search";
export const ZYRA_WEB_FETCH_TOOL_NAME = "web_fetch";

export function createZyraWebSearchTool() {
  return defineTool({
    name: ZYRA_WEB_SEARCH_TOOL_NAME,
    label: "Web search",
    description: "Search the web for current public information. Use this when a question depends on recent, changing, or source-backed facts.",
    parameters: Type.Object({
      query: Type.String({ description: "The web search query." }),
      limit: Type.Optional(Type.Number({ description: "Maximum result count, 1-8." })),
    }),
    execute: async (_toolCallId, params = {}) => {
      const query = String(params.query ?? "").trim();
      const limit = normalizeLimit(params.limit);
      if (!query) {
        return textResult("Web search needs a non-empty query.", { query, results: [] });
      }

      try {
        const results = await searchDuckDuckGoHtml(query, limit);
        if (!results.length) {
          return textResult(`No web results found for: ${query}`, { query, results });
        }
        return textResult(formatResults(query, results), { query, results });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`Web search failed for "${query}": ${message}`, { query, error: message, results: [] });
      }
    },
  });
}

export function createZyraWebFetchTool() {
  return defineTool({
    name: ZYRA_WEB_FETCH_TOOL_NAME,
    label: "Web fetch",
    description: "Fetch a public URL and return readable page text with source metadata.",
    parameters: Type.Object({
      url: Type.String({ description: "The public URL to fetch." }),
      maxBytes: Type.Optional(Type.Number({ description: "Maximum response bytes to read, up to 200000." })),
    }),
    execute: async (_toolCallId, params = {}) => {
      const url = normalizeFetchUrl(params.url);
      if (!url) {
        return textResult("Web fetch needs a valid http or https URL.", { url: params.url });
      }

      try {
        const maxBytes = normalizeMaxBytes(params.maxBytes);
        const result = await fetchReadableUrl(url, { maxBytes });
        return textResult(formatFetchedPage(result), result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`Web fetch failed for "${url}": ${message}`, { url, error: message });
      }
    },
  });
}

async function searchDuckDuckGoHtml(query, limit = DEFAULT_LIMIT) {
  const url = `${DUCKDUCKGO_HTML_URL}?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "accept": "text/html,application/xhtml+xml",
      "user-agent": "ZyraCLI/0.2 (+https://github.com/justelson/zyra)",
    },
  });
  if (!response.ok) {
    throw new Error(`search provider returned HTTP ${response.status}`);
  }
  return parseDuckDuckGoResults(await response.text(), limit);
}

function parseDuckDuckGoResults(html, limit = DEFAULT_LIMIT) {
  const blocks = String(html).split(/<div[^>]+class="[^"]*\bresult\b[^"]*"[^>]*>/i).slice(1);
  const results = [];

  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = decodeResultUrl(decodeHtml(link[1]));
    const title = cleanHtml(link[2]);
    if (!url || !title) continue;

    const snippetMatch = block.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? cleanHtml(snippetMatch[1]) : "";
    results.push({
      title: truncate(title, 140),
      url,
      snippet: truncate(snippet, 260),
    });
    if (results.length >= limit) break;
  }

  return results;
}

async function fetchReadableUrl(url, options = {}) {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const response = await fetch(url, {
    headers: {
      "accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      "user-agent": "ZyraCLI/0.2 (+https://github.com/justelson/zyra)",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`URL returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await response.arrayBuffer()).subarray(0, maxBytes);
  const raw = bytes.toString("utf8");
  const title = contentType.includes("html") ? extractTitle(raw) : "";
  const text = contentType.includes("html") ? htmlToText(raw) : normalizeWhitespace(raw);
  return {
    url: response.url || url,
    status: response.status,
    contentType,
    title,
    bytesRead: bytes.length,
    truncated: bytes.length >= maxBytes,
    text: truncate(text, 12000),
  };
}

function normalizeFetchUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function normalizeMaxBytes(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 60000;
  return Math.max(1000, Math.min(200000, number));
}

function extractTitle(html) {
  const match = String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? truncate(cleanHtml(match[1]), 180) : "";
}

function htmlToText(html) {
  return normalizeWhitespace(decodeHtml(String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|header|footer|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")));
}

function formatFetchedPage(result) {
  return [
    `Fetched URL: ${result.url}`,
    `Status: ${result.status}`,
    `Content-Type: ${result.contentType || "unknown"}`,
    result.title ? `Title: ${result.title}` : "",
    result.truncated ? `Note: response truncated after ${result.bytesRead.toLocaleString("en-US")} bytes.` : "",
    "",
    result.text || "[No readable text extracted.]",
  ].filter((line) => line !== "").join("\n");
}

function decodeResultUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, DUCKDUCKGO_HTML_URL);
    const uddg = url.searchParams.get("uddg");
    return uddg || url.href;
  } catch {
    return text;
  }
}

function cleanHtml(value) {
  return normalizeWhitespace(decodeHtml(String(value ?? "").replace(/<[^>]+>/g, " ")));
}

function decodeHtml(value) {
  return String(value ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeLimit(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, number));
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function formatResults(query, results) {
  return [
    `Web search results for: ${query}`,
    "",
    ...results.map((result, index) => [
      `${index + 1}. ${result.title}`,
      `   ${result.url}`,
      result.snippet ? `   ${result.snippet}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}
