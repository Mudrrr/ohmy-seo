import { withCache } from "@ohmy-seo/mcp-core/cache";
import { errorToMcpContent } from "@ohmy-seo/mcp-core/errors";
import { SCOPE_ADWORDS } from "@ohmy-seo/mcp-core/google-oauth";
import { resolveAccount } from "../lib/account-resolver.js";
import { digitsOnly, executeAdsCall } from "../lib/ads-client.js";
import { asText, type McpText } from "../lib/ads-runner.js";

const PKG_NAME = "google-ads";
export const TOOL_NAME = "ads_keyword_ideas";

/** Shape of one idea as Google returns it. */
interface IdeaRow {
  text?: string;
  keywordIdeaMetrics?: {
    avgMonthlySearches?: string;
    competition?: string;
    competitionIndex?: string;
    lowTopOfPageBidMicros?: string;
    highTopOfPageBidMicros?: string;
    monthlySearchVolumes?: Array<{ year?: string; month?: string; monthlySearches?: string }>;
  };
}

const MICRO = 1_000_000;

function toCurrency(micros: string | undefined): number | null {
  if (micros === undefined) return null;
  const num = Number(micros);
  return Number.isFinite(num) ? Math.round((num / MICRO) * 100) / 100 : null;
}

/**
 * Keyword research: KeywordPlanIdeaService.GenerateKeywordIdeas.
 *
 * Not a GAQL resource — this is a service method of its own, called as
 * `customers/{id}:generateKeywordIdeas`, so ads_run_query cannot reach it.
 *
 * Requires Basic access or higher: planning services are blocked at the
 * Explorer access level.
 *
 * Seeds, in the order this tool picks them:
 *   keywords + page_url -> keywordAndUrlSeed
 *   keywords            -> keywordSeed
 *   page_url            -> urlSeed
 *   site_url            -> siteSeed (crawls the whole site, not one page)
 *
 * Bids come back in micros of the account currency and are converted here;
 * `avg_monthly_searches` is Google's rounded twelve-month average, not a
 * measured number, and `competition_index` is 0-100 advertiser density, not a
 * quality signal.
 */
export async function runAdsKeywordIdeas(args: {
  account?: string;
  customer_id: string;
  login_customer_id?: string;
  keywords?: string[];
  page_url?: string;
  site_url?: string;
  geo_target_ids?: string[];
  language_id?: string;
  network?: "GOOGLE_SEARCH" | "GOOGLE_SEARCH_AND_PARTNERS";
  include_adult?: boolean;
  include_monthly_volumes?: boolean;
  limit?: number;
  page_size?: number;
  page_token?: string;
  force_refresh?: boolean;
}): Promise<McpText> {
  try {
    const customerId = digitsOnly(args.customer_id);
    if (customerId.length === 0) return asText({ error: "customer_id is required" }, true);

    const keywords = (args.keywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0);
    if (keywords.length === 0 && !args.page_url && !args.site_url) {
      return asText(
        { error: "give at least one seed: keywords, page_url or site_url" },
        true,
      );
    }

    const seed: Record<string, unknown> = {};
    if (keywords.length > 0 && args.page_url) {
      seed["keywordAndUrlSeed"] = { url: args.page_url, keywords };
    } else if (keywords.length > 0) {
      seed["keywordSeed"] = { keywords };
    } else if (args.page_url) {
      seed["urlSeed"] = { url: args.page_url };
    } else {
      seed["siteSeed"] = { site: args.site_url };
    }

    const body: Record<string, unknown> = {
      keywordPlanNetwork: args.network ?? "GOOGLE_SEARCH",
      includeAdultKeywords: args.include_adult ?? false,
      ...seed,
    };
    if (args.language_id) body["language"] = `languageConstants/${digitsOnly(args.language_id)}`;
    if (args.geo_target_ids && args.geo_target_ids.length > 0) {
      body["geoTargetConstants"] = args.geo_target_ids.map(
        (id) => `geoTargetConstants/${digitsOnly(id)}`,
      );
    }
    if (args.page_size !== undefined) body["pageSize"] = args.page_size;
    if (args.page_token !== undefined) body["pageToken"] = args.page_token;

    const account = await resolveAccount(PKG_NAME, SCOPE_ADWORDS, args.account);

    const result = await withCache(
      {
        toolName: TOOL_NAME,
        accountId: account.id,
        args: { customerId, body, limit: args.limit ?? null, monthly: args.include_monthly_volumes ?? false },
        forceRefresh: args.force_refresh ?? false,
        skipCacheIf: (r: unknown) => !(r as { ok?: boolean }).ok,
      },
      async () => {
        const res = await executeAdsCall({
          account,
          method: "POST",
          path: `customers/${customerId}:generateKeywordIdeas`,
          body,
          ...(args.login_customer_id !== undefined
            ? { loginCustomerId: digitsOnly(args.login_customer_id) }
            : {}),
        });
        if (!res.ok) return { ok: false as const, error: res.data };

        const payload = res.data as { results?: IdeaRow[]; nextPageToken?: string };
        const all = payload.results ?? [];

        const rows = all
          .map((r) => {
            const m = r.keywordIdeaMetrics ?? {};
            const row: Record<string, unknown> = {
              keyword: r.text ?? "",
              avg_monthly_searches: m.avgMonthlySearches !== undefined ? Number(m.avgMonthlySearches) : null,
              competition: m.competition ?? null,
              competition_index:
                m.competitionIndex !== undefined ? Number(m.competitionIndex) : null,
              top_of_page_bid_low: toCurrency(m.lowTopOfPageBidMicros),
              top_of_page_bid_high: toCurrency(m.highTopOfPageBidMicros),
            };
            if (args.include_monthly_volumes) {
              row["monthly"] = (m.monthlySearchVolumes ?? []).map((v) => ({
                year: v.year ?? null,
                month: v.month ?? null,
                searches: v.monthlySearches !== undefined ? Number(v.monthlySearches) : null,
              }));
            }
            return row;
          })
          .sort(
            (a, b) =>
              ((b["avg_monthly_searches"] as number | null) ?? -1) -
              ((a["avg_monthly_searches"] as number | null) ?? -1),
          );

        const limited = args.limit !== undefined ? rows.slice(0, args.limit) : rows;

        return {
          ok: true as const,
          customer_id: customerId,
          seed: Object.keys(seed)[0],
          row_count: limited.length,
          total_returned: rows.length,
          bids_in: "account currency",
          rows: limited,
          ...(payload.nextPageToken !== undefined ? { next_page_token: payload.nextPageToken } : {}),
        };
      },
    );

    return asText(result, !(result as { ok?: boolean }).ok);
  } catch (e) {
    return errorToMcpContent(e) as McpText;
  }
}