import * as cheerio from "cheerio";

export interface ScrapedResult {
  url: string;
  title: string;
  content: string;
  engine: string;
}

export interface ScrapedResponse {
  query: string;
  number_of_results: number;
  results: ScrapedResult[];
  unresponsive_engines: [string, string][];
}

export function scrapeResults(html: string): ScrapedResponse {
  const $ = cheerio.load(html);

  const results: ScrapedResult[] = [];
  const unresponsiveEngines: [string, string][] = [];

  // Extract individual search results from <article class="result">
  const container = $("#urls").length ? "#urls" : "#main_results";
  $(`${container} article.result`).each((_i, el) => {
    const $el = $(el);

    // URL: from the first <a> with class "url_header"
    const url = $el.find("a.url_header").attr("href")?.trim() ?? "";

    // Title: from <h3> > <a>, strip internal tags like <span class="highlight">
    const $titleLink = $el.find("h3 a").first();
    const title = $titleLink.length
      ? $titleLink.text().trim()
      : "";

    // Content snippet: from <p class="content">
    const content = $el.find("p.content").text().trim();

    // Engine: from <div class="engines"> first <span>
    const engine = $el.find(".engines span").first().text().trim();

    if (url) {
      results.push({ url, title, content, engine });
    }
  });

  // Total result count from <p id="result_count"><small>
  // Supports both "Number of results: 62" and "结果个数: 62"
  const countText = $("#result_count small").text() || "";
  const countMatch = countText.match(/(\d[\d,]*)/);
  const number_of_results = countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : results.length;

  // Unresponsive engines from sidebar engine stats table
  $("#engines_msg-table tr").each((_i, row) => {
    const $tds = $(row).find("td");
    if ($tds.length < 2) return;

    const engineName = $tds.eq(0).text().trim();
    const errorCell = $tds.eq(1);
    if (errorCell.hasClass("response-error")) {
      const errorMsg = errorCell.text().trim();
      unresponsiveEngines.push([engineName, errorMsg]);
    }
  });

  return {
    query: "",
    number_of_results,
    results,
    unresponsive_engines: unresponsiveEngines,
  };
}

/** Quick check: does this HTML contain a SearXNG results page? */
export function isResultsPage(html: string): boolean {
  return html.includes('id="urls"') || html.includes('id="main_results"');
}
