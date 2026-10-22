import { runMutation } from "../lib/ads-mutate.js";
import { asText, type McpText } from "../lib/ads-runner.js";
import { digitsOnly } from "../lib/ads-client.js";

export const TOOL_NAME = "ads_create_pmax";

const GEO_TYPES = new Set(["PRESENCE_OR_INTEREST", "PRESENCE"]);

/** Code-point length, the way Google counts ad text. */
const len = (s: string): number => [...s].length;

export interface CreatePmaxArgs {
  account?: string;
  customer_id: string;
  name: string;
  budget_id: string;
  bidding_strategy?: string;
  target_cpa?: number;
  target_roas?: number;
  geo_target_type?: string;
  eu_political_advertising?: boolean;
  start_date?: string;
  end_date?: string;
  locations?: string[];
  languages?: string[];
  /** Brand: business name as new text or an existing asset id. */
  business_name?: string;
  business_name_asset_id?: string;
  logo_asset_ids: string[];
  landscape_logo_asset_ids?: string[];
  /** Asset group. */
  asset_group_name: string;
  final_urls: string[];
  headlines?: string[];
  headline_asset_ids?: string[];
  long_headlines?: string[];
  long_headline_asset_ids?: string[];
  descriptions?: string[];
  description_asset_ids?: string[];
  marketing_image_asset_ids: string[];
  square_marketing_image_asset_ids: string[];
  portrait_marketing_image_asset_ids?: string[];
  search_themes?: string[];
  login_customer_id?: string;
  confirm?: boolean;
  validate_only?: boolean;
}

/**
 * Builds a whole Performance Max campaign in ONE atomic GoogleAds:mutate.
 *
 * Why atomic: new PMax campaigns get Brand Guidelines on by default, and then
 * Google refuses the campaign unless a BUSINESS_NAME and a square LOGO are
 * linked as CampaignAsset in the same request. Switching Brand Guidelines off
 * does not help — the same requirement moves to the asset group
 * (NOT_ENOUGH_BUSINESS_NAME_ASSET / NOT_ENOUGH_LOGO_ASSET). Both verified
 * 23.09.2026 with validateOnly on a test account.
 *
 * Temporary ids: campaign -1, asset group -2, new text assets -100 and down.
 * Campaign is always PAUSED; the asset group is ENABLED so the campaign runs
 * as soon as it is enabled with ads_enable_campaign.
 */
export async function runAdsCreatePmax(args: CreatePmaxArgs): Promise<McpText> {
  const cid = digitsOnly(args.customer_id);
  const budgetId = digitsOnly(args.budget_id);
  if (!budgetId) return asText({ error: "budget_id is required" }, true);

  const geoType = (args.geo_target_type ?? "PRESENCE_OR_INTEREST").trim().toUpperCase();
  if (!GEO_TYPES.has(geoType)) {
    return asText({ error: `geo_target_type must be one of ${[...GEO_TYPES].join(", ")}` }, true);
  }

  // ---- validation before anything goes to Google ---------------------------
  const problems: string[] = [];
  const headlines = args.headlines ?? [];
  const longHeadlines = args.long_headlines ?? [];
  const descriptions = args.descriptions ?? [];
  const nH = headlines.length + (args.headline_asset_ids?.length ?? 0);
  const nLH = longHeadlines.length + (args.long_headline_asset_ids?.length ?? 0);
  const nD = descriptions.length + (args.description_asset_ids?.length ?? 0);
  if (nH < 3 || nH > 15) problems.push(`headlines: need 3–15, got ${nH}`);
  if (nLH < 1 || nLH > 5) problems.push(`long headlines: need 1–5, got ${nLH}`);
  if (nD < 2 || nD > 5) problems.push(`descriptions: need 2–5, got ${nD}`);
  headlines.forEach((t) => len(t) > 30 && problems.push(`headline over 30: "${t}" (${len(t)})`));
  longHeadlines.forEach((t) => len(t) > 90 && problems.push(`long headline over 90: "${t}" (${len(t)})`));
  descriptions.forEach((t) => len(t) > 90 && problems.push(`description over 90: "${t}" (${len(t)})`));
  if (descriptions.length > 0 && !(args.description_asset_ids?.length) && !descriptions.some((t) => len(t) <= 60)) {
    problems.push("descriptions: at least one must be 60 characters or less");
  }
  const dup = (xs: string[]) => xs.filter((x, i) => xs.findIndex((y) => y.toLowerCase() === x.toLowerCase()) !== i);
  for (const [k, xs] of [["headlines", headlines], ["long_headlines", longHeadlines], ["descriptions", descriptions]] as const) {
    const d = dup(xs);
    if (d.length) problems.push(`${k}: duplicates ${JSON.stringify(d)}`);
  }
  if (!args.business_name && !args.business_name_asset_id) problems.push("business_name or business_name_asset_id is required");
  if (args.business_name && len(args.business_name) > 25) problems.push(`business_name over 25: ${len(args.business_name)}`);
  if (!args.logo_asset_ids?.length) problems.push("logo_asset_ids: at least one square logo");
  if (!args.marketing_image_asset_ids?.length) problems.push("marketing_image_asset_ids: at least one 1.91:1 image");
  if (!args.square_marketing_image_asset_ids?.length) problems.push("square_marketing_image_asset_ids: at least one 1:1 image");
  if (!args.final_urls?.length) problems.push("final_urls: at least one");
  if (problems.length) return asText({ error: "validation failed", problems }, true);

  // ---- operations -----------------------------------------------------------
  const P = `customers/${cid}`;
  const CAMP = `${P}/campaigns/-1`;
  const AG = `${P}/assetGroups/-2`;
  const asset = (id: string) => `${P}/assets/${digitsOnly(id)}`;
  let tmp = -100;
  const ops: object[] = [];
  const newText = (text: string): string => {
    const rn = `${P}/assets/${tmp--}`;
    ops.push({ assetOperation: { create: { resourceName: rn, textAsset: { text } } } });
    return rn;
  };

  // New text assets go first: later operations reference their temp ids.
  const businessName = args.business_name ? newText(args.business_name) : asset(args.business_name_asset_id!);
  const hRefs = [...headlines.map(newText), ...(args.headline_asset_ids ?? []).map(asset)];
  const lhRefs = [...longHeadlines.map(newText), ...(args.long_headline_asset_ids ?? []).map(asset)];
  const dRefs = [...descriptions.map(newText), ...(args.description_asset_ids ?? []).map(asset)];

  const campaign: Record<string, unknown> = {
    resourceName: CAMP,
    name: args.name,
    status: "PAUSED",
    advertisingChannelType: "PERFORMANCE_MAX",
    campaignBudget: `${P}/campaignBudgets/${budgetId}`,
    brandGuidelinesEnabled: true,
    containsEuPoliticalAdvertising:
      args.eu_political_advertising === true
        ? "CONTAINS_EU_POLITICAL_ADVERTISING"
        : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
    geoTargetTypeSetting: { positiveGeoTargetType: geoType, negativeGeoTargetType: "PRESENCE" },
  };
  const strategy = (args.bidding_strategy ?? "MAXIMIZE_CONVERSIONS").trim().toUpperCase();
  if (strategy === "TARGET_CPA") {
    if (!(args.target_cpa && args.target_cpa > 0)) return asText({ error: "target_cpa is required for TARGET_CPA" }, true);
    campaign["maximizeConversions"] = { targetCpaMicros: String(Math.round(args.target_cpa * 1_000_000)) };
  } else if (strategy === "TARGET_ROAS") {
    if (!(args.target_roas && args.target_roas > 0)) return asText({ error: "target_roas is required for TARGET_ROAS" }, true);
    campaign["maximizeConversionValue"] = { targetRoas: args.target_roas };
  } else if (strategy === "MAXIMIZE_CONVERSION_VALUE") {
    campaign["maximizeConversionValue"] = {};
  } else if (strategy === "MAXIMIZE_CONVERSIONS") {
    campaign["maximizeConversions"] = {};
  } else {
    return asText({ error: "bidding_strategy for PMax: MAXIMIZE_CONVERSIONS | MAXIMIZE_CONVERSION_VALUE | TARGET_CPA | TARGET_ROAS" }, true);
  }
  if (args.start_date) campaign["startDate"] = args.start_date.replace(/-/g, "");
  if (args.end_date) campaign["endDate"] = args.end_date.replace(/-/g, "");
  ops.push({ campaignOperation: { create: campaign } });

  // Brand at campaign level (Brand Guidelines).
  const ca = (a: string, fieldType: string) =>
    ops.push({ campaignAssetOperation: { create: { campaign: CAMP, asset: a, fieldType } } });
  ca(businessName, "BUSINESS_NAME");
  args.logo_asset_ids.forEach((id) => ca(asset(id), "LOGO"));
  (args.landscape_logo_asset_ids ?? []).forEach((id) => ca(asset(id), "LANDSCAPE_LOGO"));

  // Targeting.
  for (const g of args.locations ?? []) {
    ops.push({ campaignCriterionOperation: { create: { campaign: CAMP, location: { geoTargetConstant: `geoTargetConstants/${digitsOnly(g)}` } } } });
  }
  for (const l of args.languages ?? []) {
    ops.push({ campaignCriterionOperation: { create: { campaign: CAMP, language: { languageConstant: `languageConstants/${digitsOnly(l)}` } } } });
  }

  // Asset group and its assets.
  ops.push({ assetGroupOperation: { create: {
    resourceName: AG, campaign: CAMP, name: args.asset_group_name, finalUrls: args.final_urls, status: "ENABLED",
  } } });
  const aga = (a: string, fieldType: string) =>
    ops.push({ assetGroupAssetOperation: { create: { assetGroup: AG, asset: a, fieldType } } });
  hRefs.forEach((a) => aga(a, "HEADLINE"));
  lhRefs.forEach((a) => aga(a, "LONG_HEADLINE"));
  dRefs.forEach((a) => aga(a, "DESCRIPTION"));
  args.marketing_image_asset_ids.forEach((id) => aga(asset(id), "MARKETING_IMAGE"));
  args.square_marketing_image_asset_ids.forEach((id) => aga(asset(id), "SQUARE_MARKETING_IMAGE"));
  (args.portrait_marketing_image_asset_ids ?? []).forEach((id) => aga(asset(id), "PORTRAIT_MARKETING_IMAGE"));

  for (const text of args.search_themes ?? []) {
    ops.push({ assetGroupSignalOperation: { create: { assetGroup: AG, searchTheme: { text } } } });
  }

  return runMutation({
    operation: TOOL_NAME,
    customerId: args.customer_id,
    endpoint: "googleAds:mutate",
    operationsKey: "mutateOperations",
    operations: ops,
    target: { customer_id: cid, name: args.name, asset_group: args.asset_group_name },
    change: {
      status: "PAUSED (forced), asset group ENABLED",
      bidding_strategy: strategy,
      brand_guidelines: "on — business name and logo linked at campaign level",
      counts: {
        headlines: hRefs.length, long_headlines: lhRefs.length, descriptions: dRefs.length,
        marketing_images: args.marketing_image_asset_ids.length,
        square_images: args.square_marketing_image_asset_ids.length,
        locations: args.locations?.length ?? 0, languages: args.languages?.length ?? 0,
        search_themes: args.search_themes?.length ?? 0, operations: ops.length,
      },
    },
    ...(args.account !== undefined ? { account: args.account } : {}),
    ...(args.login_customer_id !== undefined ? { loginCustomerId: args.login_customer_id } : {}),
    ...(args.confirm !== undefined ? { confirm: args.confirm } : {}),
    ...(args.validate_only !== undefined ? { validate_only: args.validate_only } : {}),
  });
}
