import { runMutation } from "../lib/ads-mutate.js";
import { asText, type McpText } from "../lib/ads-runner.js";
import { digitsOnly } from "../lib/ads-client.js";

export const TOOL_NAME = "ads_update_campaign_urls";

const SUFFIX_MAX = 128; // Google's limit for final_url_suffix
const TEMPLATE_MAX = 2048;

/**
 * Sets final_url_suffix and/or tracking_url_template on one campaign.
 * Only these two fields go into the update mask — status and budget stay with
 * their DANGER tools. Pass an empty string to clear a field.
 */
export async function runAdsUpdateCampaignUrls(args: {
  account?: string;
  customer_id: string;
  campaign_id: string;
  final_url_suffix?: string;
  tracking_url_template?: string;
  login_customer_id?: string;
  confirm?: boolean;
  validate_only?: boolean;
}): Promise<McpText> {
  const customerId = digitsOnly(args.customer_id);
  const campaignId = digitsOnly(args.campaign_id);
  if (campaignId.length === 0) return asText({ error: "campaign_id is required" }, true);
  if (args.final_url_suffix === undefined && args.tracking_url_template === undefined) {
    return asText({ error: "pass final_url_suffix and/or tracking_url_template" }, true);
  }

  const update: Record<string, unknown> = { resourceName: `customers/${customerId}/campaigns/${campaignId}` };
  const mask: string[] = [];
  const change: Record<string, unknown> = {};

  if (args.final_url_suffix !== undefined) {
    // A leading "?" or "&" is a common paste artefact; Google wants the bare query.
    const suffix = args.final_url_suffix.trim().replace(/^[?&]+/, "");
    if (suffix.length > SUFFIX_MAX) {
      return asText({ error: `final_url_suffix is ${suffix.length} characters, Google allows ${SUFFIX_MAX}` }, true);
    }
    if (/\s/.test(suffix)) return asText({ error: "final_url_suffix must not contain spaces" }, true);
    update["finalUrlSuffix"] = suffix;
    mask.push("final_url_suffix");
    change["final_url_suffix"] = suffix === "" ? "(cleared)" : `${suffix} (${suffix.length}/${SUFFIX_MAX})`;
  }
  if (args.tracking_url_template !== undefined) {
    const tpl = args.tracking_url_template.trim();
    if (tpl.length > TEMPLATE_MAX) return asText({ error: `tracking_url_template over ${TEMPLATE_MAX} characters` }, true);
    if (tpl !== "" && !tpl.includes("{lpurl")) {
      return asText({ error: "tracking_url_template must contain {lpurl} (or {lpurl+2} etc.), otherwise clicks lose the landing page" }, true);
    }
    update["trackingUrlTemplate"] = tpl;
    mask.push("tracking_url_template");
    change["tracking_url_template"] = tpl === "" ? "(cleared)" : tpl;
  }

  return runMutation({
    operation: TOOL_NAME,
    customerId: args.customer_id,
    endpoint: "campaigns:mutate",
    operations: [{ update, updateMask: mask.join(",") }],
    target: { customer_id: customerId, campaign_id: campaignId },
    change,
    ...(args.account !== undefined ? { account: args.account } : {}),
    ...(args.login_customer_id !== undefined ? { loginCustomerId: args.login_customer_id } : {}),
    ...(args.confirm !== undefined ? { confirm: args.confirm } : {}),
    ...(args.validate_only !== undefined ? { validate_only: args.validate_only } : {}),
  });
}
