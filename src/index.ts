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
import axios from "axios";
import dotenv from "dotenv";
// yaml import removed — using searx.space JSON API now

dotenv.config();

// Get environment variables for SearXNG configuration
const SEARXNG_URL = process.env.SEARXNG_URL;
const SEARXNG_USERNAME = process.env.SEARXNG_USERNAME;
const SEARXNG_PASSWORD = process.env.SEARXNG_PASSWORD;
const USE_RANDOM_INSTANCE = process.env.USE_RANDOM_INSTANCE !== "false"; // Default to true if not set

// URL for searx.space instances JSON (with health/uptime/response-time data)
const INSTANCES_LIST_URL = "https://searx.space/data/instances.json";

// Engine priority (lexicographic order for comparison)
// Google > Brave > Bing > DuckDuckGo
const ENGINE_PRIORITY = ["google", "brave", "bing", "duckduckgo"] as const;
const ENGINE_LABELS = ["Go", "Br", "Bi", "Dd"];

/** Check if an engine is healthy (present and 0% error rate) */
function engineOk(engines: Record<string, any>, name: string): boolean {
  const ei = engines[name];
  if (!ei) return false;
  return typeof ei !== "object" || (ei.error_rate ?? 0) === 0;
}

function engineVector(engines: Record<string, any>): boolean[] {
  return ENGINE_PRIORITY.map((e) => engineOk(engines, e));
}

/** Compare two engine vectors lexicographically. Returns <0 if a ranks higher. */
function compareEngineVectors(a: boolean[], b: boolean[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] ? -1 : 1;
  }
  return 0;
}

/** log0.5 with rounding */
function logHalfBucket(v: number): number {
  return Math.round(Math.log(v) / Math.log(0.5));
}

interface RankedInstance {
  url: string;
  speedBucket: number;
  engineVec: boolean[];
  uptimeBucket: number;
  totalEngines: number;
  speed: number;
  uptimeMonth: number;
}

// Runtime failure tracking
const failureTracker = new Map<string, { count: number; firstFail: number; reason: string }>();
const COOLDOWN_ERROR = 5 * 60 * 1000;  // 5 min for general errors
const COOLDOWN_RATELIMIT = 60 * 60 * 1000;  // 1 hour for rate limits

function isInCooldown(url: string): boolean {
  const entry = failureTracker.get(url);
  if (!entry) return false;
  const cooldown = entry.reason === '429' ? COOLDOWN_RATELIMIT : COOLDOWN_ERROR;
  const elapsed = Date.now() - entry.firstFail;
  if (elapsed > cooldown) {
    failureTracker.delete(url);
    return false;
  }
  return entry.count >= 3;
}

function recordFailure(url: string, statusCode: number): void {
  const entry = failureTracker.get(url);
  if (entry) {
    entry.count++;
    entry.reason = String(statusCode);
  } else {
    failureTracker.set(url, { count: 1, firstFail: Date.now(), reason: String(statusCode) });
  }
  console.error(`[SearXNG] Recorded failure #${entry?.count ?? 1} for ${url} (${statusCode})`);
}

// Function to fetch and rank SearXNG instances from searx.space
async function getBestSearXNGInstance(): Promise<string> {
  try {
    console.error("[SearXNG] Fetching instances from searx.space...");
    const response = await axios.get(INSTANCES_LIST_URL, { timeout: 15000 });
    const data = response.data;
    const instances = data.instances || {};

    const ranked: RankedInstance[] = [];

    for (const [url, instance] of Object.entries(instances)) {
      const inst = instance as any;

      // ── Health filter (必要条件) ──

      if (
        inst.network_type !== "normal" ||
        inst.http?.status_code !== 200 ||
        inst.http?.error != null ||
        (inst.timing?.initial?.all?.value ?? 999) >= 1 ||
        inst.timing?.initial?.success_percentage !== 100
      ) {
        continue;
      }

      const engines = inst.engines || {};
      const vec = engineVector(engines);

      // Hard requirement: Google or Brave must be available
      if (!vec[0] && !vec[1]) continue;

      const uptime = inst.uptime || {};
      const um = uptime.uptimeMonth ?? 0;

      const speed = inst.timing?.search?.all?.median ?? 999;

      ranked.push({
        url,
        speedBucket: logHalfBucket(speed),
        engineVec: vec,
        uptimeBucket: Math.round(um),
        totalEngines: Object.keys(engines).length,
        speed,
        uptimeMonth: um,
      });
    }

    // ── Ranking (择优条件) ──
    ranked.sort((a, b) => {
      // 1. Speed bucket (log0.5, descending — faster first)
      if (b.speedBucket !== a.speedBucket) return b.speedBucket - a.speedBucket;
      // 2. Engine vector (lexicographic: G > B(rave) > B(ing) > D)
      const ec = compareEngineVectors(a.engineVec, b.engineVec);
      if (ec !== 0) return ec;
      // 3. Uptime bucket (descending — higher uptime first)
      if (b.uptimeBucket !== a.uptimeBucket) return b.uptimeBucket - a.uptimeBucket;
      // 4. Total engines (descending)
      return b.totalEngines - a.totalEngines;
    });

    console.error(`[SearXNG] Found ${ranked.length} healthy instances (from ${Object.keys(instances).length} total)`);

    if (ranked.length === 0) {
      throw new Error("No healthy SearXNG instances found on searx.space");
    }

    const engineLabel = (v: boolean[]) => ENGINE_LABELS.map((l, i) => v[i] ? l : '--').join('');
    for (const r of ranked.slice(0, 5)) {
      console.error(
        `  spd=${r.speedBucket} eng=[${engineLabel(r.engineVec)}] ` +
        `upt=${r.uptimeBucket} ` +
        `(${r.speed.toFixed(3)}s/${r.uptimeMonth.toFixed(1)}%) ${r.url}`
      );
    }

    // Pick from top 10, skip cooldown instances
    const topN = ranked.slice(0, Math.min(10, ranked.length));
    const candidates = topN.filter(r => !isInCooldown(r.url));
    const pool = candidates.length > 0 ? candidates : topN;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    console.error(`[SearXNG] Selected: ${pick.url}`);
    return pick.url;
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
  format?: string;
  safesearch?: number;
  pageno?: number;
}

// Interface for SearXNG search result
interface SearXNGResult {
  title: string;
  url: string;
  content: string;
  engine: string;
  score?: number;
  category?: string;
  pretty_url?: string;
  publishedDate?: string;
}

// Interface for SearXNG search response
interface SearXNGResponse {
  query: string;
  number_of_results: number;
  results: SearXNGResult[];
  answers?: string[];
  corrections?: string[];
  infoboxes?: any[];
  suggestions?: string[];
  unresponsive_engines?: string[];
}

class SearXNGClient {
  private server: Server;
  private axiosInstance: any;
  private instanceUrl: string;

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

        // Prepare search parameters with defaults
        const searchParams: SearchParams = {
          q: args.query,
          format: 'json',
          language: typeof args.language === 'string' ? args.language : 'en',
          safesearch: typeof args.safesearch === 'number' ? args.safesearch : 1,
          pageno: typeof args.pageno === 'number' ? args.pageno : 1,
        };

        // Add optional parameters if provided
        if (args.time_range && typeof args.time_range === 'string') searchParams.time_range = args.time_range;
        if (Array.isArray(args.categories)) searchParams.categories = args.categories;
        if (Array.isArray(args.engines)) searchParams.engines = args.engines;

        console.error(`[SearXNG] Searching for: ${args.query}`);
        
        // Make request to SearXNG
        const response = await this.axiosInstance.get('/search', {
          params: searchParams
        });

        const searchResults: SearXNGResponse = response.data;
        
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
      } catch (error: any) {
        console.error("[SearXNG Error]", error);
        
        // Record failure for cooldown tracking
        if (axios.isAxiosError(error)) {
          const status = error.response?.status ?? 0;
          recordFailure(this.instanceUrl, status);
        } else {
          recordFailure(this.instanceUrl, 0);
        }
        
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
            text: `Error: ${error.message}`
          }],
          isError: true,
        };
      }
    });
  }

  private formatResults(query: string, results: SearXNGResult[], fullResponse: SearXNGResponse): string {
    const output: string[] = [];
    
    output.push(`# Search Results for: ${query}`);
    output.push(`Found ${fullResponse.number_of_results} results\n`);

    // Add answers if available
    if (fullResponse.answers && fullResponse.answers.length > 0) {
      output.push(`## Answers`);
      fullResponse.answers.forEach(answer => {
        output.push(`- ${answer}`);
      });
      output.push('');
    }

    // Add suggestions if available
    if (fullResponse.suggestions && fullResponse.suggestions.length > 0) {
      output.push(`## Suggestions`);
      fullResponse.suggestions.forEach(suggestion => {
        output.push(`- ${suggestion}`);
      });
      output.push('');
    }

    // Add corrections if available
    if (fullResponse.corrections && fullResponse.corrections.length > 0) {
      output.push(`## Did you mean?`);
      fullResponse.corrections.forEach(correction => {
        output.push(`- ${correction}`);
      });
      output.push('');
    }

    // Format detailed search results
    output.push('## Results');
    results.forEach((result, index) => {
      output.push(`\n### ${index + 1}. ${result.title}`);
      output.push(`URL: ${result.url}`);
      if (result.engine) output.push(`Engine: ${result.engine}`);
      if (result.category) output.push(`Category: ${result.category}`);
      if (result.publishedDate) output.push(`Published: ${result.publishedDate}`);
      output.push(`\n${result.content}`);
    });

    // Add unresponsive engines if any
    if (fullResponse.unresponsive_engines && fullResponse.unresponsive_engines.length > 0) {
      output.push('\n## Unresponsive Engines');
      output.push(fullResponse.unresponsive_engines.join(', '));
    }

    return output.join('\n');
  }

  async run(): Promise<void> {
    // Determine which SearXNG instance to use
    if (!this.instanceUrl) {
      if (SEARXNG_URL) {
        // Use the specified URL if provided
        this.instanceUrl = SEARXNG_URL;
        console.error(`[SearXNG] Using specified instance: ${this.instanceUrl}`);
      } else if (USE_RANDOM_INSTANCE) {
        // Only fetch random instance if no URL is specified and random instances are enabled
        console.error("[SearXNG] No URL specified, will auto-discover best instance");
        try {
          this.instanceUrl = await getBestSearXNGInstance();
          console.error(`[SearXNG] Using random instance: ${this.instanceUrl}`);
        } catch (error) {
          console.error("[SearXNG] Error getting random instance:", error);
          throw new Error("Failed to get a random SearXNG instance. Please provide SEARXNG_URL or fix the instance fetching issue.");
        }
      } else {
        // If no URL is specified and random instances are disabled, throw an error
        throw new Error("SEARXNG_URL environment variable is required when USE_RANDOM_INSTANCE is set to false");
      }
    }

    // Create axios instance with the determined URL and auth if provided
    this.axiosInstance = axios.create({
      baseURL: this.instanceUrl,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      ...(hasBasicAuth && {
        auth: {
          username: SEARXNG_USERNAME!,
          password: SEARXNG_PASSWORD!,
        },
      }),
    });

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("SearXNG MCP server running on stdio");
    console.error(`Connected to SearXNG instance at: ${this.instanceUrl}`);
    console.error(`Basic auth: ${hasBasicAuth ? 'Enabled' : 'Disabled'}`);
    console.error(`Random instance selection: ${USE_RANDOM_INSTANCE ? 'Enabled' : 'Disabled'}`);
  }
}

const server = new SearXNGClient();
server.run().catch(console.error);
