import { errorToMcpContent } from "@ohmy-seo/mcp-core/errors";
import { SCOPE_ADWORDS } from "@ohmy-seo/mcp-core/google-oauth";
import { runMutation } from "../lib/ads-mutate.js";
import { asText, type McpText } from "../lib/ads-runner.js";
import { adsSearch, digitsOnly } from "../lib/ads-client.js";
import { resolveAccount } from "../lib/account-resolver.js";

export const ADD_TOOL = "ads_add_account_negative_placements";
export const LIST_TOOL = "ads_list_account_negative_criteria";
export const REMOVE_TOOL = "ads_remove_account_negative_criteria";

/**
 * Account-level exclusions (customer_negative_criterion). They apply to every
 * campaign in the account at once, PMax included — the only practical way to
 * keep a PMax off junk placements, because negative keywords cut search
 * queries and do nothing for Display inventory.
 *
 * The resource supports only create and remove.
 */
const TYPES: Record<string, (v: string, cid: string) => Record<string, unknown>> = {
  PLACEMENT: (v) => ({ placement: { url: v } }),
  MOBILE_APPLICATION: (v) => ({ mobileApplication: { appId: v } }),
  YOUTUBE_CHANNEL: (v) => ({ youtubeChannel: { channelId: v } }),
  YOUTUBE_VIDEO: (v) => ({ youtubeVideo: { videoId: v } }),
  CONTENT_LABEL: (v) => ({ contentLabel: { type: v.toUpperCase() } }),
  MOBILE_APP_CATEGORY: (v) => ({
    mobileAppCategory: { mobileAppCategoryConstant: `mobileAppCategoryConstants/${digitsOnly(v)}` },
  }),
};

/** quizwinz.com, https://www.quizwinz.com/ and QUIZWINZ.COM are one placement. */
function normalizePlacement(v: string): string {
  return v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export async function runAddAccountNegativePlacements(args: {
  account?: string;
  customer_id: string;
  type?: string;
  values: string[];
  login_customer_id?: string;
  confirm?: boolean;
  validate_only?: boolean;
}): Promise<McpText> {
  const type = (args.type ?? "PLACEMENT").trim().toUpperCase();
  const build = TYPES[type];
  if (!build) return asText({ error: `type must be one of ${Object.keys(TYPES).join(", ")}` }, true);

  const cid = digitsOnly(args.customer_id);
  const cleaned = args.values.map((v) => (type === "PLACEMENT" ? normalizePlacement(v) : v.trim())).filter(Boolean);
  const unique = [...new Set(cleaned)];
  if (unique.length === 0) return asText({ error: "values is empty" }, true);
  const droppedDuplicates = cleaned.length - unique.length;

  // validate_only does NOT catch "already excluded" (checked 24.09.2026 on
  // 8fat.com), so diff against the account first and send only what is new.
  let existingLines: string[];
  try {
    const ex = await fetchExclusionLines({
      customer_id: args.customer_id, type,
      ...(args.account !== undefined ? { account: args.account } : {}),
      ...(args.login_customer_id !== undefined ? { login_customer_id: args.login_customer_id } : {}),
    });
    if (!ex.ok) return asText({ ok: false, step: "reading existing exclusions", error: ex.error }, true);
    existingLines = ex.lines;
  } catch (e) {
    return errorToMcpContent(e) as McpText;
  }
  const existing = new Set(existingLines.map((l) => (l.split(" ")[1] ?? "").toLowerCase()));
  const alreadyExcluded = unique.filter((v) => existing.has(v.toLowerCase()));
  const values = unique.filter((v) => !existing.has(v.toLowerCase()));
  if (values.length === 0) {
    return asText({ operation: ADD_TOOL, applied: false, note: "nothing new — all values are already excluded", already_excluded: alreadyExcluded });
  }

  const raw = await runMutation({
    operation: ADD_TOOL,
    customerId: args.customer_id,
    endpoint: "customerNegativeCriteria:mutate",
    // Account already holds hundreds of exclusions: one duplicate must not
    // sink the whole batch.
    partialFailure: true,
    operations: values.map((v) => ({ create: build(v, cid) })),
    target: { customer_id: cid, level: "account" },
    change: {
      type, count: values.length,
      ...(droppedDuplicates ? { duplicates_in_input_dropped: droppedDuplicates } : {}),
      ...(alreadyExcluded.length ? { already_excluded_skipped: alreadyExcluded } : {}),
      values,
    },
    ...(args.account !== undefined ? { account: args.account } : {}),
    ...(args.login_customer_id !== undefined ? { loginCustomerId: args.login_customer_id } : {}),
    ...(args.confirm !== undefined ? { confirm: args.confirm } : {}),
    ...(args.validate_only !== undefined ? { validate_only: args.validate_only } : {}),
  });
  if (raw.isError || args.confirm !== true) return raw;
  return summarizePartial(raw, values, alreadyExcluded);
}

/** Turns a partialFailure response into created / rejected-with-reason. */
function summarizePartial(raw: McpText, values: string[], alreadyExcluded: string[]): McpText {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
  } catch {
    return raw;
  }
  const response = (parsed["response"] ?? {}) as {
    results?: Array<{ resourceName?: string }>;
    partialFailureError?: { details?: Array<{ errors?: Array<Record<string, unknown>> }> };
  };
  const rejected: Array<{ value: string; reason: string }> = [];
  for (const d of response.partialFailureError?.details ?? []) {
    for (const e of d.errors ?? []) {
      const loc = (e["location"] as { fieldPathElements?: Array<{ fieldName?: string; index?: number }> } | undefined)
        ?.fieldPathElements?.find((f) => f.fieldName === "operations");
      const code = Object.values((e["errorCode"] ?? {}) as Record<string, string>).join(",");
      rejected.push({
        value: loc?.index !== undefined ? values[loc.index] ?? `#${loc.index}` : "?",
        reason: `${code}${e["message"] ? `: ${String(e["message"])}` : ""}`,
      });
    }
  }
  const createdCount = (response.results ?? []).filter((r) => r.resourceName).length;
  const validated = parsed["validated_only"] === true;
  return asText({
    operation: parsed["operation"],
    applied: parsed["applied"],
    validated_only: validated,
    sent: values.length,
    [validated ? "would_create" : "created"]: validated ? values.length - rejected.length : createdCount,
    rejected_count: rejected.length,
    rejected,
    ...(alreadyExcluded.length ? { already_excluded_skipped: alreadyExcluded } : {}),
    ...(parsed["via_manager"] ? { via_manager: parsed["via_manager"] } : {}),
  });
}

type ListArgs = { account?: string; customer_id: string; type?: string; login_customer_id?: string };

/** All exclusions as "TYPE value criterion_id" lines, sorted. */
async function fetchExclusionLines(
  args: ListArgs,
): Promise<{ ok: true; lines: string[]; byType: Record<string, number> } | { ok: false; error: unknown }> {
  const account = await resolveAccount("google-ads", SCOPE_ADWORDS, args.account);
  const type = args.type ? args.type.trim().toUpperCase().replace(/[^A-Z_]/g, "") : "";
  const query =
    "SELECT customer_negative_criterion.id, customer_negative_criterion.type, " +
    "customer_negative_criterion.placement.url, customer_negative_criterion.mobile_application.app_id, " +
    "customer_negative_criterion.mobile_application.name, customer_negative_criterion.youtube_channel.channel_id, " +
    "customer_negative_criterion.youtube_video.video_id, customer_negative_criterion.content_label.type, " +
    "customer_negative_criterion.mobile_app_category.mobile_app_category_constant " +
    "FROM customer_negative_criterion" +
    (type ? ` WHERE customer_negative_criterion.type = '${type}'` : "");
  const r = await adsSearch(account, args.customer_id, query, args.login_customer_id);
  if (!r.ok) return { ok: false, error: r.error };

  const lines: string[] = [];
  const byType: Record<string, number> = {};
  for (const row of r.rows as Array<{ customerNegativeCriterion?: Record<string, unknown> }>) {
    const c = row.customerNegativeCriterion ?? {};
    const t = String(c["type"] ?? "?");
    byType[t] = (byType[t] ?? 0) + 1;
    const pick = (k: string, f: string) => (c[k] as Record<string, unknown> | undefined)?.[f];
    const value =
      pick("placement", "url") ??
      (pick("mobileApplication", "appId") !== undefined
        ? `${String(pick("mobileApplication", "appId"))}${pick("mobileApplication", "name") ? ` (${String(pick("mobileApplication", "name"))})` : ""}`
        : undefined) ??
      pick("youtubeChannel", "channelId") ??
      pick("youtubeVideo", "videoId") ??
      pick("contentLabel", "type") ??
      pick("mobileAppCategory", "mobileAppCategoryConstant") ??
      "";
    lines.push(`${t} ${String(value)} ${String(c["id"] ?? "")}`);
  }
  lines.sort();
  return { ok: true, lines, byType };
}

/**
 * Flat, compact list: one line per exclusion "TYPE value id". A raw GAQL dump
 * of 200+ rows repeats every key and runs past the 25k answer limit.
 */
export async function runListAccountNegativeCriteria(args: ListArgs & { limit?: number }): Promise<McpText> {
  try {
    const r = await fetchExclusionLines(args);
    if (!r.ok) return asText({ ok: false, error: r.error }, true);
    const limit = args.limit && args.limit > 0 ? args.limit : 450; // ~45 chars a line pretty-printed: stays under the 25k answer limit
    return asText({
      ok: true,
      customer_id: digitsOnly(args.customer_id),
      total: r.lines.length,
      by_type: r.byType,
      format: "TYPE value criterion_id",
      ...(r.lines.length > limit ? { truncated: `showing ${limit} of ${r.lines.length} — narrow with type or raise limit` } : {}),
      lines: r.lines.slice(0, limit),
    });
  } catch (e) {
    return errorToMcpContent(e) as McpText;
  }
}

/**
 * DANGER: removing an exclusion reopens that inventory for every campaign in
 * the account at once — same logic as detaching a negative list.
 */
export async function runRemoveAccountNegativeCriteria(args: {
  account?: string;
  customer_id: string;
  criterion_ids: string[];
  login_customer_id?: string;
  confirm?: boolean;
  acknowledge_live?: string;
}): Promise<McpText> {
  const cid = digitsOnly(args.customer_id);
  const ids = [...new Set(args.criterion_ids.map(digitsOnly).filter(Boolean))];
  if (ids.length === 0) return asText({ error: "criterion_ids is empty" }, true);
  return runMutation({
    operation: REMOVE_TOOL,
    customerId: args.customer_id,
    endpoint: "customerNegativeCriteria:mutate",
    operations: ids.map((id) => ({ remove: `customers/${cid}/customerNegativeCriteria/${id}` })),
    target: { customer_id: cid, level: "account" },
    change: { removed_criterion_ids: ids },
    danger: true,
    resourceId: `customerNegativeCriteria/${ids.join(",")}`,
    ...(args.account !== undefined ? { account: args.account } : {}),
    ...(args.login_customer_id !== undefined ? { loginCustomerId: args.login_customer_id } : {}),
    ...(args.confirm !== undefined ? { confirm: args.confirm } : {}),
    ...(args.acknowledge_live !== undefined ? { acknowledge_live: args.acknowledge_live } : {}),
  });
}
