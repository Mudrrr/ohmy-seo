import { withCache } from "@ohmy-seo/mcp-core/cache";
import { errorToMcpContent } from "@ohmy-seo/mcp-core/errors";
import { SCOPE_ADWORDS } from "@ohmy-seo/mcp-core/google-oauth";
import { resolveAccount } from "../lib/account-resolver.js";
import { digitsOnly, executeAdsCall } from "../lib/ads-client.js";
import { asText, type McpText } from "../lib/ads-runner.js";
import { PRIMARY_FIELDS } from "../lib/gaql-builder.js";

const PKG_NAME = "google-ads";
export const TOOL_NAME = "ads_resource_metadata";

/**
 * Which fields a GAQL resource actually has, and which metrics and segments
 * may be selected alongside it. Call this instead of guessing field names —
 * the answer is stable and cached for 24 hours.
 */
export async function runAdsResourceMetadata(args: {
  account?: string;
  customer_id: string;
  resource: string;
  login_customer_id?: string;
  force_refresh?: boolean;
  /** attributes | enums | metrics | segments — default: everything that fits. */
  section?: string;
}): Promise<McpText> {
  try {
    const account = await resolveAccount(PKG_NAME, SCOPE_ADWORDS, args.account);
    const resource = args.resource.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (resource.length === 0) return asText({ error: "resource is empty" }, true);

    const customerId = digitsOnly(args.customer_id);
    const loginCustomerId = args.login_customer_id ? digitsOnly(args.login_customer_id) : undefined;

    // GoogleAdsFieldService has its own query language: no FROM clause, and it
    // is served by googleAdsFields:search, NOT customers/{id}/googleAds:search.
    // Sending it through the customer endpoint returns UNRECOGNIZED_FIELD on
    // every column (fixed 23.09.2026).
    const attributesQuery =
      "SELECT name, category, data_type, selectable, filterable, sortable, is_repeated, enum_values " +
      `WHERE name LIKE '${resource}.%' AND category = 'ATTRIBUTE'`;
    const compatibleQuery =
      "SELECT name, category, data_type " +
      `WHERE selectable_with CONTAINS ANY ('${resource}') ` +
      "AND category IN ('METRIC', 'SEGMENT')";
    const fieldSearch = async (query: string) => {
      const r = await executeAdsCall({
        account, method: "POST", path: "googleAdsFields:search", body: { query, pageSize: 10000 },
        ...(loginCustomerId !== undefined ? { loginCustomerId } : {}),
      });
      return r.ok
        ? { ok: true as const, rows: ((r.data as { results?: unknown[] }).results ?? []) }
        : { ok: false as const, error: r.data };
    };

    const result = await withCache(
      {
        toolName: TOOL_NAME,
        accountId: account.id,
        args: { resource, customerId },
        forceRefresh: args.force_refresh ?? false,
        skipCacheIf: (r: unknown) => !(r as { ok?: boolean }).ok,
      },
      async () => {
        const attributes = await fieldSearch(attributesQuery);
        if (!attributes.ok) return { ok: false as const, error: attributes.error };
        const compatible = await fieldSearch(compatibleQuery);
        return {
          ok: true as const,
          resource,
          required_primary_field: PRIMARY_FIELDS[resource] ?? null,
          // Compact on purpose: full rows for a big resource like campaign run
          // to ~40k characters and hit the 25k answer limit. Prefixes are
          // stripped (attributes are `${resource}.x`, metrics `metrics.x`,
          // segments `segments.x`), enum lists drop UNSPECIFIED/UNKNOWN.
          prefix: `${resource}.`,
          attributes: (attributes.rows as Array<Record<string, unknown>>).map((f) => {
            const flags = [
              f["selectable"] === false ? "not-selectable" : "",
              f["filterable"] === false ? "not-filterable" : "",
              f["isRepeated"] ? "repeated" : "",
            ].filter(Boolean).join(",");
            return `${String(f["name"]).slice(resource.length + 1)} ${String(f["dataType"])}${flags ? ` [${flags}]` : ""}`;
          }),
          enum_values: Object.fromEntries(
            (attributes.rows as Array<Record<string, unknown>>)
              .filter((f) => Array.isArray(f["enumValues"]))
              .map((f) => [
                String(f["name"]).slice(resource.length + 1),
                (f["enumValues"] as string[]).filter((v) => v !== "UNSPECIFIED" && v !== "UNKNOWN").join("|"),
              ]),
          ),
          ...(compatible.ok
            ? (() => {
                const names = (compatible.rows as Array<Record<string, unknown>>).map((f) => String(f["name"]));
                return {
                  metrics: names.filter((n) => n.startsWith("metrics.")).map((n) => n.slice(8)).join(", "),
                  segments: names.filter((n) => n.startsWith("segments.")).map((n) => n.slice(9)).join(", "),
                };
              })()
            : { metrics_and_segments_error: compatible.error }),
        };
      },
    );

    if (!(result as { ok?: boolean }).ok) return asText(result, true);

    const full = result as Record<string, unknown>;
    const head = { ok: true, resource: full["resource"], required_primary_field: full["required_primary_field"], prefix: full["prefix"] };
    const section = (args.section ?? "").trim().toLowerCase();
    if (section === "attributes") return asText({ ...head, attributes: full["attributes"] });
    if (section === "enums") return asText({ ...head, enum_values: full["enum_values"] });
    if (section === "metrics") return asText({ ...head, metrics: full["metrics"] });
    if (section === "segments") return asText({ ...head, segments: full["segments"] });

    // Big resources (campaign) do not fit the 25k answer limit with enums.
    if (JSON.stringify(full, null, 2).length > 24_000) {
      const { enum_values: _omit, ...rest } = full;
      return asText({ ...rest, enum_values: "omitted to fit the answer limit — call again with section:\"enums\"" });
    }
    return asText(full);
  } catch (e) {
    return errorToMcpContent(e) as McpText;
  }
}
