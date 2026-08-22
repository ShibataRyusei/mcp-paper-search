import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import { parseStringPromise } from "xml2js";
import fs from "fs";
import path from "path";

const USER_AGENT = "AntigravityPaperSearch/1.0 (mailto:antigravity@gemini.ai)";
const TIMEOUT = 7000; // 7 seconds timeout

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

/**
 * Search arXiv API for Computer Science, Physics, Math, AI papers
 */
async function searchArxiv(query: string, maxResults: number): Promise<PaperResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodedQuery}&start=0&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`;
  
  try {
    const response = await axios.get(url, {
      headers: { "User-Agent": USER_AGENT },
      timeout: TIMEOUT,
      responseType: "text",
    });

    const parsed = await parseStringPromise(response.data);
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

      // Authors
      const authors: string[] = [];
      if (Array.isArray(entry.author)) {
        for (const a of entry.author) {
          const name = Array.isArray(a.name) ? a.name[0] : a.name;
          if (name) authors.push(String(name).trim());
        }
      }

      // PDF URL
      let pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
      if (Array.isArray(entry.link)) {
        for (const link of entry.link) {
          if (link.$?.title === "pdf" || link.$?.type === "application/pdf") {
            pdfUrl = link.$.href;
            break;
          }
        }
      }

      // Categories
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
    console.error(`[arXiv Error] ${error.message}`);
    return [];
  }
}

/**
 * Search Crossref API for global academic literature & DOIs
 */
async function searchCrossref(query: string, maxResults: number): Promise<PaperResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://api.crossref.org/works?query=${encodedQuery}&rows=${maxResults}`;

  try {
    const response = await axios.get(url, {
      headers: { "User-Agent": USER_AGENT },
      timeout: TIMEOUT,
    });

    const items = response.data?.message?.items || [];
    const results: PaperResult[] = [];

    for (const item of items) {
      const title = Array.isArray(item.title) ? item.title[0] : "No Title";
      const doi = item.DOI || "";
      const paperUrl = item.URL || (doi ? `https://doi.org/${doi}` : "");

      // Authors
      const authors: string[] = [];
      if (Array.isArray(item.author)) {
        for (const a of item.author) {
          const name = `${a.given || ""} ${a.family || ""}`.trim();
          if (name) authors.push(name);
        }
      }

      // Year
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
    console.error(`[Crossref Error] ${error.message}`);
    return [];
  }
}

/**
 * Search CiNii Research API for Japanese academic papers
 */
async function searchCinii(query: string, maxResults: number): Promise<PaperResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://ci.nii.ac.jp/books/opensearch/search?q=${encodedQuery}&format=json&count=${maxResults}`;

  try {
    const response = await axios.get(url, {
      headers: { "User-Agent": USER_AGENT },
      timeout: TIMEOUT,
    });

    const graph = response.data?.["@graph"] || [];
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
    console.error(`[CiNii Error] ${error.message}`);
    return [];
  }
}

/**
 * Download arXiv paper PDF to local directory
 */
async function downloadPaperPdf(urlOrId: string, outdir: string): Promise<string | null> {
  try {
    fs.mkdirSync(outdir, { recursive: true });

    let pdfUrl = urlOrId;
    let filename = urlOrId.split("/").pop() || "paper.pdf";

    if (!urlOrId.startsWith("http")) {
      pdfUrl = `https://arxiv.org/pdf/${urlOrId}.pdf`;
      filename = `${urlOrId}.pdf`;
    } else if (!filename.endsWith(".pdf")) {
      filename += ".pdf";
    }

    const targetPath = path.join(outdir, filename);
    const response = await axios.get(pdfUrl, {
      headers: { "User-Agent": USER_AGENT },
      responseType: "arraybuffer",
      timeout: 30000,
    });

    fs.writeFileSync(targetPath, Buffer.from(response.data));
    return path.resolve(targetPath);
  } catch (error: any) {
    console.error(`[PDF Download Error] ${error.message}`);
    return null;
  }
}

/**
 * Format search results as Github-style Markdown
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

// Set up Stdio MCP Server
const server = new Server(
  {
    name: "paper-search-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define Tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
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
        description: "Download paper PDF from arXiv ID or PDF URL to local workspace.",
        inputSchema: {
          type: "object",
          properties: {
            url_or_id: {
              type: "string",
              description: "arXiv ID (e.g. '2402.11651') or direct PDF URL",
            },
            outdir: {
              type: "string",
              default: "./downloads",
              description: "Output directory for the PDF",
            },
          },
          required: ["url_or_id"],
        },
      },
    ],
  };
});

// Implement Tool Calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

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
      content: [
        {
          type: "text",
          text: markdown,
        },
      ],
    };
  }

  if (name === "download_paper_pdf") {
    const urlOrId = String(args?.url_or_id || "");
    const outdir = String(args?.outdir || "./downloads");

    const downloadedPath = await downloadPaperPdf(urlOrId, outdir);

    return {
      content: [
        {
          type: "text",
          text: downloadedPath
            ? `Successfully downloaded PDF to: ${downloadedPath}`
            : `Failed to download PDF from: ${urlOrId}`,
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Server execution error:", err);
  process.exit(1);
});
