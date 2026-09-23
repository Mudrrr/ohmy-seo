import { runMutation } from "../lib/ads-mutate.js";
import { asText, type McpText } from "../lib/ads-runner.js";
import { digitsOnly } from "../lib/ads-client.js";

export const TOOL_NAME = "ads_invite_client_account";

/**
 * Invites a client Google Ads account to link under a manager account (MCC).
 *
 * This is the onboarding step: once the client accepts the invitation in their
 * own account, the account appears under the MCC and every credential that can
 * reach the MCC — including the service account — can work with it. No Cloud
 * project, OAuth client or service account has to be created per client.
 *
 * The invitation is created with status PENDING. Nothing in the client account
 * changes until they accept it, so this is not a DANGER tool; the usual
 * confirm / validate_only locks still apply.
 *
 * Check the result with:
 *   SELECT customer_client_link.client_customer, customer_client_link.status,
 *          customer_client_link.manager_link_id
 *   FROM customer_client_link
 * run against the manager account.
 */
export async function runAdsInviteClientAccount(args: {
  account?: string;
  manager_customer_id: string;
  client_customer_id: string;
  confirm?: boolean;
  validate_only?: boolean;
}): Promise<McpText> {
  const managerId = digitsOnly(args.manager_customer_id);
  const clientId = digitsOnly(args.client_customer_id);
  if (managerId.length === 0) return asText({ error: "manager_customer_id is required" }, true);
  if (clientId.length === 0) return asText({ error: "client_customer_id is required" }, true);
  if (managerId === clientId) {
    return asText({ error: "manager_customer_id and client_customer_id must differ" }, true);
  }

  return runMutation({
    operation: TOOL_NAME,
    customerId: managerId,
    endpoint: "customerClientLinks:mutate",
    singleOperation: true,
    operations: [
      {
        create: {
          clientCustomer: "customers/" + clientId,
          status: "PENDING",
        },
      },
    ],
    target: { manager_customer_id: managerId, client_customer_id: clientId },
    change: { invitation: "PENDING" },
    loginCustomerId: managerId,
    ...(args.account !== undefined ? { account: args.account } : {}),
    ...(args.confirm !== undefined ? { confirm: args.confirm } : {}),
    ...(args.validate_only !== undefined ? { validate_only: args.validate_only } : {}),
  });
}