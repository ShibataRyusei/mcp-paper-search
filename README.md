# mcp-paper-search

Academic Paper Search MCP Server for Antigravity AI Assistant.

Searches research papers across arXiv, Crossref, and CiNii, formats results as Markdown, and downloads PDFs.

## Features

- **arXiv**: Search Computer Science, AI, Physics, Math preprints.
- **Crossref**: Search global academic literature and DOIs.
- **CiNii**: Search Japanese university and academic publications.
- **PDF Download**: Download paper PDFs directly to your workspace.

## Tools Provided

### 1. `paper_search`
Search academic papers across databases.
- `query` (string, required): Search keywords.
- `source` ("all" | "arxiv" | "crossref" | "cini"): Target database.
- `max_results` (number): Max results per source.

### 2. `download_paper_pdf`
Download paper PDF from arXiv ID or PDF URL.
- `url_or_id` (string, required): arXiv ID or PDF URL.
- `outdir` (string): Target directory.

## Installation

```bash
npm install
```

## Antigravity Configuration (`mcp_config.json`)

Add the following to `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "paper-search-mcp": {
      "command": "node",
      "args": [
        "/Users/shibata/Documents/Documents - MacBook Pro/GitHub/mcp-paper-search/node_modules/tsx/dist/cli.mjs",
        "/Users/shibata/Documents/Documents - MacBook Pro/GitHub/mcp-paper-search/index.ts"
      ],
      "cwd": "/Users/shibata/Documents/Documents - MacBook Pro/GitHub/mcp-paper-search"
    }
  }
}
```
