import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { parseStringPromise } from "xml2js";

const SERVER_INFO = {
  name: "mcp-paper-search",
  version: "1.0.0",
};

const USER_AGENT = "AntigravityPaperSearch/1.0 (mailto:antigravity@gemini.ai)";
const TIMEOUT_MS = 7000;

interface PaperResult {
  source: string;
  id: string;
  title: string;
  authors: string[];
  published: string;
  journal?: string;
  abstract?: string;
  url: string;
  pdf_url?: string;
  doi?: string;
  categories?: string[];
}

const TOOLS_DEFINITIONS = [
  {
    name: "paper_search",
    description: "Search academic research papers across arXiv, Crossref, and CiNii.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query keywords (e.g. 'large language model agent' or '人工知能')",
        },
        source: {
          type: "string",
          enum: ["all", "arxiv", "crossref", "cini"],
          default: "all",
          description: "Data source to query",
        },
        max_results: {
          type: "integer",
          default: 5,
          description: "Maximum results per source",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "download_paper_pdf",
    description: "Get direct PDF download URL for an arXiv ID or PDF link.",
    inputSchema: {
      type: "object",
      properties: {
        url_or_id: {
          type: "string",
          description: "arXiv ID (e.g. '2402.11651') or direct PDF URL",
        },
      },
      required: ["url_or_id"],
    },
  },
];

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

/**
 * Search arXiv API
 */
async function searchArxiv(query: string, maxResults: number): Promise<PaperResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodedQuery}&start=0&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`;

  try {
    const response = await fetchWithTimeout(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    const xmlData = await response.text();

    const parsed = await parseStringPromise(xmlData);
    const entries = parsed.feed?.entry || [];
    const results: PaperResult[] = [];

    for (const entry of entries) {
      const rawTitle = Array.isArray(entry.title) ? entry.title[0] : entry.title || "";
      const title = String(rawTitle).replace(/\s+/g, " ").trim();

      const rawSummary = Array.isArray(entry.summary) ? entry.summary[0] : entry.summary || "";
      const abstract = String(rawSummary).replace(/\s+/g, " ").trim();

      const publishedStr = Array.isArray(entry.published) ? entry.published[0] : entry.published || "";
      const published = String(publishedStr).slice(0, 10);

      const entryId = Array.isArray(entry.id) ? entry.id[0] : entry.id || "";
      const arxivId = String(entryId).split("/").pop() || "";

      const authors: string[] = [];
      if (Array.isArray(entry.author)) {
        for (const a of entry.author) {
          const name = Array.isArray(a.name) ? a.name[0] : a.name;
          if (name) authors.push(String(name).trim());
        }
      }

      let pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
      if (Array.isArray(entry.link)) {
        for (const link of entry.link) {
          if (link.$?.title === "pdf" || link.$?.type === "application/pdf") {
            pdfUrl = link.$.href;
            break;
          }
        }
      }

      const categories: string[] = [];
      if (Array.isArray(entry.category)) {
        for (const cat of entry.category) {
          if (cat.$?.term) categories.push(cat.$.term);
        }
      }

      results.push({
        source: "arXiv",
        id: arxivId,
        title,
        authors: authors.slice(0, 5),
        published,
        abstract,
        url: entryId,
        pdf_url: pdfUrl,
        categories: categories.slice(0, 3),
      });
    }

    return results;
  } catch (error: any) {
    console.error(`[arXiv Error] ${error?.message || error}`);
    return [];
  }
}

/**
 * Search Crossref API
 */
async function searchCrossref(query: string, maxResults: number): Promise<PaperResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://api.crossref.org/works?query=${encodedQuery}&rows=${maxResults}`;

  try {
    const response = await fetchWithTimeout(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    const data: any = await response.json();

    const items = data?.message?.items || [];
    const results: PaperResult[] = [];

    for (const item of items) {
      const title = Array.isArray(item.title) ? item.title[0] : "No Title";
      const doi = item.DOI || "";
      const paperUrl = item.URL || (doi ? `https://doi.org/${doi}` : "");

      const authors: string[] = [];
      if (Array.isArray(item.author)) {
        for (const a of item.author) {
          const name = `${a.given || ""} ${a.family || ""}`.trim();
          if (name) authors.push(name);
        }
      }

      const publishedObj = item["published-print"] || item["published-online"] || item.created;
      let year = "";
      if (publishedObj?.["date-parts"]?.[0]?.[0]) {
        year = String(publishedObj["date-parts"][0][0]);
      }

      const journal = item["container-title"]?.[0] || "";
      let abstract = item.abstract || "";
      if (abstract) {
        abstract = abstract.replace(/<[^>]+>/g, "").trim();
        if (abstract.length > 500) {
          abstract = abstract.slice(0, 500) + "...";
        }
      }

      results.push({
        source: "Crossref",
        id: doi,
        title,
        authors: authors.slice(0, 5),
        published: year,
        journal,
        abstract,
        url: paperUrl,
        doi,
      });
    }

    return results;
  } catch (error: any) {
    console.error(`[Crossref Error] ${error?.message || error}`);
    return [];
  }
}

/**
 * Search CiNii Research API
 */
async function searchCinii(query: string, maxResults: number): Promise<PaperResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://ci.nii.ac.jp/books/opensearch/search?q=${encodedQuery}&format=json&count=${maxResults}`;

  try {
    const response = await fetchWithTimeout(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    const data: any = await response.json();

    const graph = data?.["@graph"] || [];
    const items = Array.isArray(graph) && graph.length > 0 ? graph[0]?.items || [] : [];
    const results: PaperResult[] = [];

    for (const item of items) {
      const title = item.title || "無題";
      const link = item["@id"] || "";
      const journal = item["dc:publisher"] || "";
      const published = item["dc:date"] || "";

      const authors: string[] = [];
      const creator = item["dc:creator"];
      if (typeof creator === "string") {
        authors.push(creator);
      } else if (Array.isArray(creator)) {
        for (const c of creator) {
          if (typeof c === "string") authors.push(c);
        }
      }

      results.push({
        source: "CiNii",
        id: link.split("/").pop() || "",
        title,
        authors: authors.slice(0, 5),
        published,
        journal,
        abstract: "",
        url: link,
      });
    }

    return results;
  } catch (error: any) {
    console.error(`[CiNii Error] ${error?.message || error}`);
    return [];
  }
}

/**
 * Format search results into Markdown
 */
function formatMarkdown(results: PaperResult[], query: string): string {
  const lines: string[] = [
    `# 論文検索結果: \`${query}\``,
    "",
    `全 ${results.length} 件の論文が見つかりました。\n`,
  ];

  results.forEach((paper, idx) => {
    lines.push(`### ${idx + 1}. [${paper.title}](${paper.url})`);

    const infoBits: string[] = [];
    if (paper.source) infoBits.push(`**ソース**: \`${paper.source}\``);
    if (paper.published) infoBits.push(`**発行/出版**: ${paper.published}`);
    if (paper.authors.length > 0) infoBits.push(`**著者**: ${paper.authors.join(", ")}`);
    if (paper.journal) infoBits.push(`**掲載**: ${paper.journal}`);
    if (paper.categories && paper.categories.length > 0) {
      infoBits.push(`**カテゴリ**: ${paper.categories.join(", ")}`);
    }

    lines.push(infoBits.join(" | "));

    if (paper.pdf_url) {
      lines.push(`- **PDFリンク**: [PDFを開く/ダウンロード](${paper.pdf_url})`);
    }
    if (paper.doi) {
      lines.push(`- **DOI**: [${paper.doi}](https://doi.org/${paper.doi})`);
    }

    if (paper.abstract) {
      lines.push("\n> **アブストラクト (概要)**:");
      paper.abstract.split("\n").forEach((line) => {
        if (line.trim()) lines.push(`> ${line.trim()}`);
      });
    }

    lines.push("\n---");
  });

  return lines.join("\n");
}

/**
 * Tool execution handler
 */
async function handleToolCall(name: string, args: any): Promise<any> {
  if (name === "paper_search") {
    const query = String(args?.query || "");
    const source = String(args?.source || "all");
    const maxResults = Number(args?.max_results || 5);

    const results: PaperResult[] = [];

    if (source === "arxiv" || source === "all") {
      const arxivResults = await searchArxiv(query, maxResults);
      results.push(...arxivResults);
    }
    if (source === "crossref" || source === "all") {
      const crossrefResults = await searchCrossref(query, maxResults);
      results.push(...crossrefResults);
    }
    if (source === "cini" || source === "all") {
      const ciniiResults = await searchCinii(query, maxResults);
      results.push(...ciniiResults);
    }

    const markdown = formatMarkdown(results, query);
    return {
      content: [{ type: "text", text: markdown }],
    };
  }

  if (name === "download_paper_pdf") {
    const urlOrId = String(args?.url_or_id || "");
    let pdfUrl = urlOrId;
    if (!urlOrId.startsWith("http")) {
      pdfUrl = `https://arxiv.org/pdf/${urlOrId}.pdf`;
    }
    return {
      content: [
        {
          type: "text",
          text: `Direct PDF link for ${urlOrId}: ${pdfUrl}`,
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

function createMcpServer(): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS_DEFINITIONS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await handleToolCall(request.params.name, request.params.arguments);
  });

  return server;
}

// Web Worker SSE Transport for Cloudflare Workers
class WebWorkerSSEServerTransport implements Transport {
  private controller: ReadableStreamDefaultController<Uint8Array>;
  private encoder = new TextEncoder();
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  constructor(controller: ReadableStreamDefaultController<Uint8Array>) {
    this.controller = controller;
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {
    try {
      this.controller.close();
    } catch {}
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const data = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    try {
      this.controller.enqueue(this.encoder.encode(data));
    } catch {}
  }

  async handleIncomingMessage(message: JSONRPCMessage): Promise<void> {
    if (this.onmessage) {
      this.onmessage(message);
    }
  }
}

const sessions = new Map<string, { transport: WebWorkerSSEServerTransport; server: Server }>();

// Direct HTTP JSON-RPC handler for stateless validation (Gemini Spark / HTTP Clients)
async function processDirectJsonRpc(body: any): Promise<any> {
  const { method, params, id } = body;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: id ?? 0,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: id ?? 0,
      result: { tools: TOOLS_DEFINITIONS },
    };
  }

  if (method === "tools/call") {
    try {
      const result = await handleToolCall(params?.name, params?.arguments);
      return { jsonrpc: "2.0", id: id ?? 0, result };
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        id: id ?? 0,
        error: { code: -32603, message: err?.message || "Execution error" },
      };
    }
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id: id ?? 0, result: {} };
  }

  return { jsonrpc: "2.0", id: id ?? null, result: {} };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Return 404 for OAuth discovery requests (tells client no auth is required)
    if (url.pathname.startsWith("/.well-known/")) {
      return new Response("Not Found", { status: 404, headers: corsHeaders });
    }

    // 1. GET /sse or GET / -> Initialize SSE Stream
    if (request.method === "GET" && (url.pathname === "/sse" || url.pathname === "/")) {
      const sessionId = crypto.randomUUID();
      let streamController: ReadableStreamDefaultController<Uint8Array>;

      const stream = new ReadableStream({
        start(controller) {
          streamController = controller;
          const endpointUrl = `${url.origin}/message?sessionId=${sessionId}`;
          const endpointMessage = `event: endpoint\ndata: ${endpointUrl}\n\n`;
          controller.enqueue(new TextEncoder().encode(endpointMessage));
        },
        cancel() {
          sessions.delete(sessionId);
        },
      });

      const transport = new WebWorkerSSEServerTransport(streamController!);
      const server = createMcpServer();

      sessions.set(sessionId, { transport, server });
      ctx.waitUntil(server.connect(transport));

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // 2. POST -> Session SSE message or Stateless Direct JSON-RPC
    if (request.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      let body: any;
      try {
        body = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
      }

      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.handleIncomingMessage(body);
        return new Response("Accepted", { status: 202, headers: corsHeaders });
      }

      // Stateless fallback for discovery validation
      try {
        const responseJson = await processDirectJsonRpc(body);
        return new Response(JSON.stringify(responseJson), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body?.id ?? null,
            error: { code: -32603, message: err?.message || "Internal error" },
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
};
