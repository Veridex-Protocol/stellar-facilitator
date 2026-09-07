/**
 * Veridex Bazaar Search Evaluation - Judged Query Benchmark Dataset (Qrels)
 * License: Apache-2.0
 */

export interface BenchmarkDocument {
  id: string;
  serviceName: string;
  description: string;
  tags: string[];
  toolName?: string;
  resourceType: "http" | "mcp";
}

export interface JudgedQuery {
  query: string;
  description: string;
  category: "exact" | "paraphrase" | "zero_lexical_overlap" | "ambiguous" | "no_result" | "mcp" | "filtered";
  filters?: {
    resourceType?: "http" | "mcp";
    toolName?: string;
    tags?: string[];
  };
  expectedNoResults?: boolean;
  // Map of document ID to graded relevance: 3 = Perfect, 2 = Highly relevant, 1 = Marginally relevant, 0 = Irrelevant
  qrels: Record<string, number>;
}

export const BENCHMARK_DOCUMENTS: BenchmarkDocument[] = [
  {
    id: "doc-weather-01",
    serviceName: "Global Weather Forecast API",
    description: "Real-time weather data, 14-day forecasts, temperature, precipitation, and severe storm alerts worldwide.",
    tags: ["weather", "forecast", "climate", "temperature"],
    resourceType: "http",
  },
  {
    id: "doc-weather-02",
    serviceName: "Historical Climate Records",
    description: "Historical weather observations, archive climate datasets, and temperature anomalies from 1950 to present.",
    tags: ["weather", "climate", "history", "data"],
    resourceType: "http",
  },
  {
    id: "doc-soroban-rpc-01",
    serviceName: "High Throughput Soroban RPC Gateway",
    description: "Dedicated low-latency Soroban JSON-RPC node provider supporting testnet and pubnet smart contract simulation.",
    tags: ["stellar", "soroban", "rpc", "node"],
    resourceType: "http",
  },
  {
    id: "doc-soroban-indexer-02",
    serviceName: "Soroban Event Stream & Indexer",
    description: "Websocket and REST API for real-time Soroban contract events, token transfer indexing, and transaction logs.",
    tags: ["stellar", "soroban", "indexer", "events"],
    resourceType: "http",
  },
  {
    id: "doc-nlp-translate-01",
    serviceName: "Multilingual Neural Translation API",
    description: "Modern machine translation across 100+ languages with automatic language detection.",
    tags: ["ai", "nlp", "translation", "language"],
    toolName: "translate_text",
    resourceType: "mcp",
  },
  {
    id: "doc-nlp-summarize-02",
    serviceName: "Document & Article Summarizer",
    description: "Extract key insights, executive summaries, and bullet points from long-form text and PDF documents.",
    tags: ["ai", "nlp", "summary", "text"],
    toolName: "summarize_document",
    resourceType: "mcp",
  },
  {
    id: "doc-stellar-dex-01",
    serviceName: "Stellar DEX Liquidity & Swap Aggregator",
    description: "Optimal trade routing across Stellar SDEX orderbooks and AMM liquidity pools for USDC, XLM, and EURC.",
    tags: ["stellar", "dex", "swap", "defi", "usdc"],
    resourceType: "http",
  },
  {
    id: "doc-image-gen-01",
    serviceName: "Generative Image & Diffusion Studio",
    description: "High-resolution AI image generation, style transfer, and neural inpainting powered by diffusion models.",
    tags: ["ai", "image", "generation", "diffusion"],
    toolName: "generate_image",
    resourceType: "mcp",
  },
  {
    id: "doc-code-audit-01",
    serviceName: "Smart Contract Static Security Analyzer",
    description: "Automated vulnerability scanner for Soroban Rust and Solidity contracts detecting reentrancy and integer overflow.",
    tags: ["security", "audit", "soroban", "rust"],
    toolName: "analyze_code",
    resourceType: "mcp",
  },
  {
    id: "doc-crypto-rates-01",
    serviceName: "Real-Time Crypto Price Feed Oracle",
    description: "Sub-second streaming price quotes and orderbook depth for XLM, BTC, ETH, and stablecoins.",
    tags: ["crypto", "price", "oracle", "market-data"],
    resourceType: "http",
  },
];

export const BENCHMARK_QUERIES: JudgedQuery[] = [
  {
    query: "weather forecast temperature",
    description: "Query for live weather and forecast information",
    category: "exact",
    qrels: {
      "doc-weather-01": 3,
      "doc-weather-02": 2,
      "doc-crypto-rates-01": 0,
      "doc-soroban-rpc-01": 0,
    },
  },
  {
    query: "Soroban RPC node smart contract",
    description: "Query for Soroban developer infrastructure and RPC provider",
    category: "exact",
    qrels: {
      "doc-soroban-rpc-01": 3,
      "doc-soroban-indexer-02": 2,
      "doc-code-audit-01": 1,
      "doc-weather-01": 0,
    },
  },
  {
    query: "translate spanish to english text",
    description: "Query for neural machine translation service",
    category: "paraphrase",
    qrels: {
      "doc-nlp-translate-01": 3,
      "doc-nlp-summarize-02": 1,
      "doc-weather-01": 0,
    },
  },
  {
    query: "Stellar USDC token swap DEX aggregator",
    description: "Query for DEX liquidity and swap routing on Stellar",
    category: "exact",
    qrels: {
      "doc-stellar-dex-01": 3,
      "doc-crypto-rates-01": 2,
      "doc-soroban-rpc-01": 1,
      "doc-image-gen-01": 0,
    },
  },
  {
    query: "AI image generator diffusion",
    description: "Query for generative diffusion image tools",
    category: "exact",
    qrels: {
      "doc-image-gen-01": 3,
      "doc-nlp-translate-01": 0,
      "doc-weather-01": 0,
    },
  },
  {
    query: "smart contract security audit Rust Soroban",
    description: "Query for contract security review and static analysis",
    category: "exact",
    qrels: {
      "doc-code-audit-01": 3,
      "doc-soroban-rpc-01": 1,
      "doc-soroban-indexer-02": 1,
      "doc-stellar-dex-01": 0,
    },
  },
  {
    query: "linguistic conversion",
    description: "Zero-overlap paraphrase for machine translation; expected to expose the current non-semantic retrieval limit",
    category: "zero_lexical_overlap",
    qrels: {
      "doc-nlp-translate-01": 3,
    },
  },
  {
    query: "stream",
    description: "Ambiguous query relevant to both event streaming and streaming market data",
    category: "ambiguous",
    qrels: {
      "doc-soroban-indexer-02": 3,
      "doc-crypto-rates-01": 2,
    },
  },
  {
    query: "summarize_document",
    description: "Exact MCP tool-name lookup",
    category: "mcp",
    filters: { resourceType: "mcp" },
    qrels: {
      "doc-nlp-summarize-02": 3,
    },
  },
  {
    query: "smart contract",
    description: "Highly specific MCP type and tool-name filter",
    category: "filtered",
    filters: { resourceType: "mcp", toolName: "analyze_code", tags: ["security"] },
    qrels: {
      "doc-code-audit-01": 3,
    },
  },
  {
    query: "quantum livestock genomics",
    description: "Known no-result query with no relevant catalog document",
    category: "no_result",
    expectedNoResults: true,
    qrels: {},
  },
  {
    query: "severe storm precipitation alerts",
    description: "Live weather hazard and precipitation lookup",
    category: "exact",
    qrels: { "doc-weather-01": 3, "doc-weather-02": 1 },
  },
  {
    query: "14 day climate outlook",
    description: "Forecast horizon phrased as an outlook",
    category: "paraphrase",
    qrels: { "doc-weather-01": 3, "doc-weather-02": 1 },
  },
  {
    query: "historical temperature anomalies",
    description: "Literal historical climate lookup",
    category: "exact",
    qrels: { "doc-weather-02": 3, "doc-weather-01": 1 },
  },
  {
    query: "weather archive since 1950",
    description: "Historical observation archive lookup",
    category: "exact",
    qrels: { "doc-weather-02": 3 },
  },
  {
    query: "past atmospheric observations",
    description: "Historical climate paraphrase",
    category: "paraphrase",
    qrels: { "doc-weather-02": 3 },
  },
  {
    query: "contract simulation testnet RPC",
    description: "Soroban simulation infrastructure lookup",
    category: "exact",
    qrels: { "doc-soroban-rpc-01": 3, "doc-soroban-indexer-02": 1 },
  },
  {
    query: "low latency Stellar node provider",
    description: "RPC provider paraphrase",
    category: "paraphrase",
    qrels: { "doc-soroban-rpc-01": 3 },
  },
  {
    query: "contract event websocket",
    description: "Soroban event stream lookup",
    category: "exact",
    qrels: { "doc-soroban-indexer-02": 3, "doc-soroban-rpc-01": 1 },
  },
  {
    query: "token transfer transaction logs",
    description: "Indexer transaction data lookup",
    category: "exact",
    qrels: { "doc-soroban-indexer-02": 3, "doc-crypto-rates-01": 1 },
  },
  {
    query: "ledger event ingestion",
    description: "Indexer concept paraphrase",
    category: "paraphrase",
    qrels: { "doc-soroban-indexer-02": 3 },
  },
  {
    query: "machine translation 100 languages",
    description: "Literal multilingual translation lookup",
    category: "exact",
    qrels: { "doc-nlp-translate-01": 3 },
  },
  {
    query: "automatic language detection",
    description: "Translation capability lookup",
    category: "exact",
    qrels: { "doc-nlp-translate-01": 3 },
  },
  {
    query: "convert french prose into german",
    description: "Translation task paraphrase",
    category: "paraphrase",
    qrels: { "doc-nlp-translate-01": 3 },
  },
  {
    query: "executive summary PDF",
    description: "Document summarizer lookup",
    category: "exact",
    qrels: { "doc-nlp-summarize-02": 3 },
  },
  {
    query: "extract key insights from article",
    description: "Article summarization task",
    category: "paraphrase",
    qrels: { "doc-nlp-summarize-02": 3 },
  },
  {
    query: "AMM liquidity pools USDC",
    description: "Stellar liquidity venue lookup",
    category: "exact",
    qrels: { "doc-stellar-dex-01": 3, "doc-crypto-rates-01": 1 },
  },
  {
    query: "optimal Stellar trade routing",
    description: "DEX route optimization lookup",
    category: "exact",
    qrels: { "doc-stellar-dex-01": 3 },
  },
  {
    query: "exchange XLM for EURC",
    description: "Token swap task paraphrase",
    category: "paraphrase",
    qrels: { "doc-stellar-dex-01": 3 },
  },
  {
    query: "BTC ETH streaming price quotes",
    description: "Crypto price feed lookup",
    category: "exact",
    qrels: { "doc-crypto-rates-01": 3 },
  },
  {
    query: "orderbook depth oracle",
    description: "Market data oracle lookup",
    category: "exact",
    qrels: { "doc-crypto-rates-01": 3, "doc-stellar-dex-01": 1 },
  },
  {
    query: "high resolution diffusion art",
    description: "Image generation lookup",
    category: "exact",
    qrels: { "doc-image-gen-01": 3 },
  },
  {
    query: "neural inpainting style transfer",
    description: "Image editing capability lookup",
    category: "exact",
    qrels: { "doc-image-gen-01": 3 },
  },
  {
    query: "create a picture from a prompt",
    description: "Image generation task paraphrase",
    category: "paraphrase",
    qrels: { "doc-image-gen-01": 3 },
  },
  {
    query: "reentrancy integer overflow scanner",
    description: "Smart-contract vulnerability scanner lookup",
    category: "exact",
    qrels: { "doc-code-audit-01": 3 },
  },
  {
    query: "review Soroban Rust for vulnerabilities",
    description: "Contract audit task paraphrase",
    category: "paraphrase",
    qrels: { "doc-code-audit-01": 3, "doc-soroban-rpc-01": 1 },
  },
  {
    query: "real time data",
    description: "Ambiguous live-data lookup across weather, events, and prices",
    category: "ambiguous",
    qrels: { "doc-weather-01": 2, "doc-soroban-indexer-02": 2, "doc-crypto-rates-01": 2 },
  },
  {
    query: "Stellar contract service",
    description: "Ambiguous Stellar contract tooling lookup",
    category: "ambiguous",
    qrels: { "doc-soroban-rpc-01": 3, "doc-soroban-indexer-02": 2, "doc-code-audit-01": 2 },
  },
  {
    query: "AI text tool",
    description: "Ambiguous AI language tool lookup",
    category: "ambiguous",
    qrels: { "doc-nlp-translate-01": 3, "doc-nlp-summarize-02": 3 },
  },
  {
    query: "translate_text",
    description: "Exact translation MCP tool name",
    category: "mcp",
    filters: { resourceType: "mcp" },
    qrels: { "doc-nlp-translate-01": 3 },
  },
  {
    query: "generate_image",
    description: "Exact image MCP tool name",
    category: "mcp",
    filters: { resourceType: "mcp" },
    qrels: { "doc-image-gen-01": 3 },
  },
  {
    query: "analyze_code",
    description: "Exact security MCP tool name",
    category: "mcp",
    filters: { resourceType: "mcp" },
    qrels: { "doc-code-audit-01": 3 },
  },
  {
    query: "AI summary",
    description: "MCP-only language summary filter",
    category: "filtered",
    filters: { resourceType: "mcp", tags: ["summary"] },
    qrels: { "doc-nlp-summarize-02": 3 },
  },
  {
    query: "Stellar service",
    description: "HTTP-only Stellar infrastructure filter",
    category: "filtered",
    filters: { resourceType: "http", tags: ["stellar"] },
    qrels: { "doc-soroban-rpc-01": 3, "doc-soroban-indexer-02": 2, "doc-stellar-dex-01": 2 },
  },
  {
    query: "language tool",
    description: "Exact translation tool filter with general query",
    category: "filtered",
    filters: { resourceType: "mcp", toolName: "translate_text" },
    qrels: { "doc-nlp-translate-01": 3 },
  },
  {
    query: "condense lengthy publication",
    description: "Zero-overlap paraphrase for document summarization",
    category: "zero_lexical_overlap",
    qrels: { "doc-nlp-summarize-02": 3 },
  },
  {
    query: "fungible asset venue",
    description: "Zero-overlap paraphrase for token exchange",
    category: "zero_lexical_overlap",
    qrels: { "doc-stellar-dex-01": 3 },
  },
  {
    query: "atmospheric prediction service",
    description: "Low-overlap weather forecast paraphrase",
    category: "zero_lexical_overlap",
    qrels: { "doc-weather-01": 3 },
  },
  {
    query: "marine biology genome alignment",
    description: "Known no-result scientific query",
    category: "no_result",
    expectedNoResults: true,
    qrels: {},
  },
  {
    query: "restaurant reservation inventory",
    description: "Known no-result commerce query",
    category: "no_result",
    expectedNoResults: true,
    qrels: {},
  },
];
