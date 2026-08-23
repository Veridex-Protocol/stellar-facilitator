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
    description: "State of the art machine translation across 100+ languages with automatic language detection.",
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
    qrels: {
      "doc-nlp-translate-01": 3,
      "doc-nlp-summarize-02": 1,
      "doc-weather-01": 0,
    },
  },
  {
    query: "Stellar USDC token swap DEX aggregator",
    description: "Query for DEX liquidity and swap routing on Stellar",
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
    qrels: {
      "doc-image-gen-01": 3,
      "doc-nlp-translate-01": 0,
      "doc-weather-01": 0,
    },
  },
  {
    query: "smart contract security audit Rust Soroban",
    description: "Query for contract security review and static analysis",
    qrels: {
      "doc-code-audit-01": 3,
      "doc-soroban-rpc-01": 1,
      "doc-soroban-indexer-02": 1,
      "doc-stellar-dex-01": 0,
    },
  },
];
