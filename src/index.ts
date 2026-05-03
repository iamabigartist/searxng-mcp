#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";
import dotenv from "dotenv";
import {
  classifySearchError,
  computeSkipUntil,
  createRuntimeState,
  InstanceRuntimeState,
  loadRuntimeState,
  pruneRuntimeState,
  recordFailure,
  recordSuccess,
  RuntimeStateStore,
  saveRuntimeState,
} from "./instance-state.js";
import { engineLabel, INSTANCES_LIST_URL, RankedInstance, rankInstances } from "./ranking.js";
import { isResultsPage, scrapeResults } from "./html-scrape.js";

dotenv.config();

// Get environment variables for SearXNG configuration
const SEARXNG_URL = process.env.SEARXNG_URL;
const SEARXNG_USERNAME = process.env.SEARXNG_USERNAME;
const SEARXNG_PASSWORD = process.env.SEARXNG_PASSWORD;
const USE_RANDOM_INSTANCE = process.env.USE_RANDOM_INSTANCE !== "false"; // Default to true if not set

const MAX_FALLBACK_ELAPSED_MS = 30_000;

// Function to fetch and rank SearXNG instances from searx.space
async function getRankedSearXNGInstances(): Promise<RankedInstance[]> {
  try {
    console.error("[SearXNG] Fetching instances from searx.space...");
    const response = await axios.get(INSTANCES_LIST_URL, { timeout: 15000 });
    const data = response.data as { instances?: Record<string, unknown> };
    const instances = data.instances ?? {};
    const ranked = rankInstances(instances);

    console.error(`[SearXNG] Found ${ranked.length} healthy instances (from ${Object.keys(instances).length} total)`);

    if (ranked.length === 0) {
      throw new Error("No healthy SearXNG instances found on searx.space");
    }

    for (const r of ranked.slice(0, 5)) {
      console.error(
        `  spd=${r.speedBucket} eng=[${engineLabel(r.engineVec)}] ` +
        `upt=${r.uptimeBucket} ` +
        `(${r.speed.toFixed(3)}s/${r.uptimeMonth.toFixed(1)}%) ${r.url}`
      );
    }

    return ranked;
  } catch (error) {
    console.error("[SearXNG] Error fetching instances:", error);
    throw new Error("Failed to fetch SearXNG instances from searx.space");
  }
}

// No need to determine the URL here, we'll do it in the run() method

// Basic auth credentials are optional
const hasBasicAuth = SEARXNG_USERNAME && SEARXNG_PASSWORD;

// Interface for SearXNG search parameters
interface SearchParams {
  q: string;
  language?: string;
  time_range?: string;
  categories?: string[];
  engines?: string[];
  safesearch?: number;
  pageno?: number;
}

// Interface for SearXNG search response
interface SearXNGResponse {
  query: string;
  number_of_results: number;
  results: unknown[];
  answers?: string[];
  corrections?: string[];
  infoboxes?: unknown[];
  suggestions?: string[];
  unresponsive_engines?: [string, string][];
}

class SearXNGClient {
  private server: Server;
  private axiosInstance?: AxiosInstance;
  private instanceUrl: string;
  private rankedInstances: RankedInstance[] = [];
  private runtimeState: RuntimeStateStore = {};
  private _dirty: boolean = false;
  private _saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(instanceUrl?: string) {
    this.instanceUrl = instanceUrl || "";
    
    this.server = new Server(
      {
        name: "searxngmcp",
        version: "0.2.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    // Initialize without axios instance - will be created during run()
    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    process.on('SIGINT', async () => {
      await this.flushStateIfDirty();
      await this.server.close();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Define available tools
      const tools: Tool[] = [
        {
          name: "searxngsearch",
          description: "Perform web searches using SearXNG, a privacy-respecting metasearch engine. Returns relevant web content with customizable parameters.",
          inputSchema: {
            type: "object",
            properties: {
              query: { 
                type: "string", 
                description: "Search query" 
              },
              language: {
                type: "string",
                description: "Language code for search results (e.g., 'en', 'de', 'fr'). Default: 'en'",
                default: "en"
              },
              time_range: {
                type: "string",
                enum: ["day", "week", "month", "year"],
                description: "Time range for search results. Options: 'day', 'week', 'month', 'year'. Default: null (no time restriction).",
                default: null
              },
              categories: {
                type: "array",
                items: { type: "string" },
                description: "Categories to search in (e.g., 'general', 'images', 'news'). Default: null (all categories).",
                default: null
              },
              engines: {
                type: "array",
                items: { type: "string" },
                description: "Specific search engines to use. Default: null (all available engines).",
                default: null
              },
              safesearch: {
                type: "number",
                enum: [0, 1, 2],
                description: "Safe search level: 0 (off), 1 (moderate), 2 (strict). Default: 1 (moderate).",
                default: 1
              },
              pageno: {
                type: "number",
                description: "Page number for results. Must be minimum 1. Default: 1.",
                minimum: 1,
                default: 1
              },
              max_results: { 
                type: "number", 
                description: "Maximum number of search results to return. Range: 1-50. Default: 10.",
                default: 10,
                minimum: 1,
                maximum: 50
              }
            },
            required: ["query"]
          }
        }
      ];
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        if (request.params.name !== "searxngsearch") {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
        }

        const args = request.params.arguments ?? {};
        
        // Validate required parameters
        if (!args.query || typeof args.query !== 'string') {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Query parameter is required and must be a string"
          );
        }
        if (args.query.trim().length === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Query parameter must be a non-empty string"
          );
        }

        // Prepare search parameters with defaults
        const searchParams: SearchParams = {
          q: args.query,
          language: typeof args.language === 'string' ? args.language : 'en',
          safesearch: typeof args.safesearch === 'number' ? args.safesearch : 1,
          pageno: typeof args.pageno === 'number' ? args.pageno : 1,
        };

        // Add optional parameters if provided
        if (args.time_range && typeof args.time_range === 'string') searchParams.time_range = args.time_range;
        if (Array.isArray(args.categories)) searchParams.categories = args.categories;
        if (Array.isArray(args.engines)) searchParams.engines = args.engines;

        console.error('[SearXNG] Performing search');
        
        const searchResults = await this.search(searchParams);
        
        // Limit results if max_results is specified
        const maxResults = typeof args.max_results === 'number' ? args.max_results : 10;
        const limitedResults = searchResults.results.slice(0, maxResults);

        // Construct a new response object with the limited results
        const finalResponse: SearXNGResponse = {
          ...searchResults, // Copy other fields like query, answers, suggestions etc.
          results: limitedResults, // Use the truncated results list
          number_of_results: limitedResults.length // Update the count to reflect the truncation
        };

        // Return the modified JSON data
        return {
          content: [{
            type: "text",
            text: JSON.stringify(finalResponse, null, 2)
          }]
        };
      } catch (error: unknown) {
        console.error("[SearXNG Error]", error instanceof Error ? error.message : String(error).slice(0,200));
        
        if (axios.isAxiosError(error)) {
          // Handle authentication errors
          if (error.response?.status === 401) {
            return {
              content: [{
                type: "text",
                text: "Authentication failed. Please check your SearXNG username and password."
              }],
              isError: true,
            };
          }
          
          return {
            content: [{
              type: "text",
              text: `SearXNG API error: ${error.response?.data?.message ?? error.message}`
            }],
            isError: true,
          };
        }
        
        return {
          content: [{
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true,
        };
      }
    });
  }

  private async search(params: SearchParams): Promise<SearXNGResponse> {
    if (this.instanceUrl) {
      if (!this.axiosInstance) throw new Error("SearXNG client is not initialized");
      const startedAt = Date.now();
      const response = await this.axiosInstance.get('/search', { params });
      const html: unknown = response.data;
      if (typeof html !== "string" || !isResultsPage(html)) {
        throw invalidResponseError();
      }
      const scraped = scrapeResults(html);
      scraped.query = params.q;
      console.error(`[SearXNG] Search succeeded in ${Date.now() - startedAt}ms via ${this.instanceUrl}`);
      return scraped as SearXNGResponse;
    }

    return this.searchWithFallback(params);
  }

  private async searchWithFallback(params: SearchParams): Promise<SearXNGResponse> {
    if (this.rankedInstances.length === 0) {
      this.rankedInstances = await getRankedSearXNGInstances();
      this.runtimeState = pruneRuntimeState(this.runtimeState, new Set(this.rankedInstances.map((i) => i.url)));
      this.markStateDirty();
    }

    const startedAt = Date.now();
    const errors: string[] = [];
    let attempts = 0;

    for (const instance of this.rankedInstances) {
      if (Date.now() - startedAt >= MAX_FALLBACK_ELAPSED_MS) break;

      const currentState = this.getRuntimeState(instance.url);
      const skipUntil = computeSkipUntil(currentState);
      if (skipUntil !== undefined) {
        console.error(`[SearXNG] Skipping ${instance.url} until ${skipUntil === Number.POSITIVE_INFINITY ? "forever" : new Date(skipUntil).toISOString()}`);
        continue;
      }

      attempts++;
      const requestStartedAt = Date.now();
      try {
        console.error(`[SearXNG] Trying ranked instance #${attempts}: ${instance.url}`);

        let parsedUrl: URL;
        try { parsedUrl = new URL(instance.url); } catch { continue; }
        if (parsedUrl.protocol !== "https:") { console.error(`[SearXNG] Skipping non-HTTPS: ${instance.url}`); continue; }
        const hn = parsedUrl.hostname;
        if (hn === "localhost" || hn === "127.0.0.1" || hn === "::1" || hn.startsWith("10.") || hn.startsWith("172.16.") || hn.startsWith("192.168.") || hn.startsWith("169.254.") || hn.startsWith("0.")) { console.error(`[SearXNG] Skipping internal IP: ${instance.url}`); continue; }

        const response = await axios.get(`${parsedUrl.origin}/search`, {
          params,
          timeout: 15_000,
          maxRedirects: 0,
          validateStatus: (status) => status >= 200 && status < 300,
          headers: {
            "Accept": "text/html, application/xhtml+xml;q=0.9, */*;q=0.8",
            "Accept-Language": params.language ?? "en",
            "User-Agent": "Mozilla/5.0 (compatible; searxng-mcp/0.2.0; +https://github.com/iamabigartist/searxng-mcp)",
          },
        });

        const html: unknown = response.data;
        if (typeof html !== "string" || !isResultsPage(html)) {
          throw invalidResponseError();
        }

        const scraped = scrapeResults(html);
        scraped.query = params.q;

        this.runtimeState[instance.url] = recordSuccess(currentState, {
          latencyMs: Date.now() - requestStartedAt,
          now: Date.now(),
        });
        this.markStateDirty();
        console.error(`[SearXNG] Search succeeded via ${instance.url}`);
        await this.flushStateIfDirty();
        return scraped as SearXNGResponse;
      } catch (error) {
        const errorClass = classifySearchError(error);
        this.runtimeState[instance.url] = recordFailure(currentState, {
          errorClass,
          statusCode: this.statusCode(error),
          now: Date.now(),
        });
        this.markStateDirty();
        errors.push(`${instance.url}: ${errorClass}`);
        console.error(`[SearXNG] Instance failed (${errorClass}): ${instance.url}`);
      }
    }

    await this.flushStateIfDirty();
    throw new Error(`All attempted SearXNG instances failed (${attempts} attempted): ${errors.join("; ")}`);
  }

  private getRuntimeState(url: string): InstanceRuntimeState {
    const state = this.runtimeState[url] ?? createRuntimeState(url);
    this.runtimeState[url] = state;
    return state;
  }

  private statusCode(error: unknown): number | undefined {
    if (axios.isAxiosError(error)) return error.response?.status;
    return undefined;
  }

  private markStateDirty(): void {
    this._dirty = true;
    if (this._saveDebounceTimer) clearTimeout(this._saveDebounceTimer);
    this._saveDebounceTimer = setTimeout(async () => {
      // no-op: save happens in flushStateIfDirty
    }, 2000);
  }

  private async flushStateIfDirty(): Promise<void> {
    if (!this._dirty) return;
    this._dirty = false;
    try { await saveRuntimeState(this.runtimeState); } catch (e) { console.error("[SearXNG] Failed to save runtime state", e); }
  }

  async run(): Promise<void> {
    this.runtimeState = await loadRuntimeState();

    // Determine which SearXNG instance to use
    if (!this.instanceUrl) {
      if (SEARXNG_URL) {
        // Use the specified URL if provided
        this.instanceUrl = SEARXNG_URL;
        console.error(`[SearXNG] Using specified instance: ${this.instanceUrl}`);
      } else if (USE_RANDOM_INSTANCE) {
        console.error("[SearXNG] No URL specified, will use ranked public-instance fallback");
        try {
          this.rankedInstances = await getRankedSearXNGInstances();
          this.runtimeState = pruneRuntimeState(this.runtimeState, new Set(this.rankedInstances.map((i) => i.url)));
          await saveRuntimeState(this.runtimeState);
        } catch (error) {
          console.error("[SearXNG] Error getting ranked instances:", error);
          throw new Error("Failed to get SearXNG instances. Please provide SEARXNG_URL or fix the instance fetching issue.");
        }
      } else {
        // If no URL is specified and random instances are disabled, throw an error
        throw new Error("SEARXNG_URL environment variable is required when USE_RANDOM_INSTANCE is set to false");
      }
    }

    if (this.instanceUrl) {
      // Create axios instance with the determined URL and auth if provided
      this.axiosInstance = axios.create({
        baseURL: this.instanceUrl,
        timeout: 15_000,
        headers: {
          'Accept': 'text/html, application/xhtml+xml;q=0.9, */*;q=0.8',
          'Content-Type': 'application/json',
        },
        ...(hasBasicAuth && {
          auth: {
            username: SEARXNG_USERNAME!,
            password: SEARXNG_PASSWORD!,
          },
        }),
      });
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("SearXNG MCP server running on stdio");
    console.error(this.instanceUrl ? `Connected to SearXNG instance at: ${this.instanceUrl}` : `Connected with ${this.rankedInstances.length} ranked public instances`);
    console.error(`Basic auth: ${hasBasicAuth ? 'Enabled' : 'Disabled'}`);
    console.error(`Random instance selection: ${USE_RANDOM_INSTANCE ? 'Enabled' : 'Disabled'}`);
  }
}

const server = new SearXNGClient();
server.run().catch((e) => { console.error(e); process.exit(1); });

function invalidResponseError(): Error & { code: string } {
  const error = new Error("SearXNG returned an invalid response shape") as Error & { code: string };
  error.code = "ESEARXNG_INVALID_RESPONSE";
  return error;
}
