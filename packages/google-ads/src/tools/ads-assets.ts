import { errorToMcpContent } from "@ohmy-seo/mcp-core/errors";
import { SCOPE_ADWORDS } from "@ohmy-seo/mcp-core/google-oauth";
import { runMutation } from "../lib/ads-mutate.js";
import { asText, type McpText } from "../lib/ads-runner.js";
import { adsSearch, digitsOnly } from "../lib/ads-client.js";
import { resolveAccount } from "../lib/account-resolver.js";

export const CREATE_TOOL = "ads_create_assets";
export const CAMPAIGN_LINK_TOOL = "ads_link_campaign_assets";
export const GROUP_LINK_TOOL = "ads_link_asset_group_assets";

/** Code points, the way Google counts ad text. */
const len = (s: string): number => [...s].length;

// ---------------------------------------------------------------------------
// ads_create_assets
// ---------------------------------------------------------------------------

const TEXT_ROLES: Record<string, number> = {
  HEADLINE: 30, LONG_HEADLINE: 90, DESCRIPTION: 90, BUSINESS_NAME: 25,
};
const SNIPPET_HEADERS = [
  "Amenities", "Brands", "Courses", "Degree programs", "Destinations", "Featured hotels",
  "Insurance coverage", "Models", "Neighborhoods", "Service catalog", "Shows", "Styles", "Types",
];
const PRICE_TYPES = new Set([
  "BRANDS", "EVENTS", "LOCATIONS", "NEIGHBORHOODS", "PRODUCT_CATEGORIES", "PRODUCT_TIERS",
  "SERVICES", "SERVICE_CATEGORIES", "SERVICE_TIERS",
]);
const PRICE_QUALIFIERS = new Set(["FROM", "UP_TO", "AVERAGE"]);

/** Image kinds Google accepts in PMax / campaigns: aspect ratio and minimum size. */
const IMAGE_KINDS: Record<string, { ratio: number; minW: number; minH: number }> = {
  MARKETING_IMAGE: { ratio: 1.91, minW: 600, minH: 314 },
  SQUARE_MARKETING_IMAGE: { ratio: 1, minW: 300, minH: 300 },
  PORTRAIT_MARKETING_IMAGE: { ratio: 0.8, minW: 480, minH: 600 },
  LOGO: { ratio: 1, minW: 128, minH: 128 },
  LANDSCAPE_LOGO: { ratio: 4, minW: 512, minH: 128 },
};
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface AssetInput {
  kind: string;
  /** text */
  text?: string;
  role?: string;
  /** sitelink */
  link_text?: string;
  description1?: string;
  description2?: string;
  final_urls?: string[];
  /** callout */
  callout_text?: string;
  /** structured_snippet */
  header?: string;
  values?: string[];
  /** price */
  price_type?: string;
  price_qualifier?: string;
  language_code?: string;
  currency_code?: string;
  offerings?: Array<{ header: string; description: string; amount: number; final_url: string }>;
  /** image */
  url?: string;
  name?: string;
  image_kind?: string;
}

/** Width/height from PNG, GIF or JPEG bytes; Google accepts only these three. */
function imageSize(b: Uint8Array): { w: number; h: number; mime: string } | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20), mime: "image/png" };
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { w: b[6]! | (b[7]! << 8), h: b[8]! | (b[9]! << 8), mime: "image/gif" };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1]!;
      const segLen = (b[i + 2]! << 8) | b[i + 3]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: (b[i + 5]! << 8) | b[i + 6]!, w: (b[i + 7]! << 8) | b[i + 8]!, mime: "image/jpeg" };
      }
      i += 2 + segLen;
    }
  }
  return undefined;
}

function matchImageKind(w: number, h: number, wanted?: string): { kind?: string; error?: string } {
  const r = w / h;
  const candidates = wanted ? [wanted.toUpperCase()] : Object.keys(IMAGE_KINDS).filter((k) => !k.includes("LOGO"));
  for (const k of candidates) {
    const spec = IMAGE_KINDS[k];
    if (!spec) return { error: `image_kind must be one of ${Object.keys(IMAGE_KINDS).join(", ")}` };
    if (Math.abs(r - spec.ratio) / spec.ratio > 0.01) continue;
    if (w < spec.minW || h < spec.minH) return { error: `${w}×${h} is below the ${k} minimum ${spec.minW}×${spec.minH}` };
    return { kind: k };
  }
  return { error: `${w}×${h} (ratio ${r.toFixed(3)}) does not fit ${candidates.join(" / ")}` };
}

async function buildAsset(a: AssetInput, i: number): Promise<{ asset?: Record<string, unknown>; note?: Record<string, unknown>; error?: string }> {
  const at = `assets[${i}]`;
  const kind = (a.kind ?? "").trim().toLowerCase();
  const tooLong = (field: string, v: string | undefined, max: number) =>
    v !== undefined && len(v) > max ? `${at}.${field}: ${len(v)} > ${max} ("${v}")` : undefined;

  if (kind === "text") {
    if (!a.text?.trim()) return { error: `${at}: text is required` };
    const role = (a.role ?? "").toUpperCase();
    const max = role ? TEXT_ROLES[role] : 90;
    if (max === undefined) return { error: `${at}.role must be one of ${Object.keys(TEXT_ROLES).join(", ")}` };
    const e = tooLong("text", a.text, max);
    if (e) return { error: e };
    return { asset: { textAsset: { text: a.text } } };
  }
  if (kind === "sitelink") {
    if (!a.link_text?.trim()) return { error: `${at}: link_text is required` };
    if (!a.final_urls?.length) return { error: `${at}: final_urls is required` };
    if (Boolean(a.description1) !== Boolean(a.description2)) return { error: `${at}: description1 and description2 go together` };
    const e = tooLong("link_text", a.link_text, 25) ?? tooLong("description1", a.description1, 35) ?? tooLong("description2", a.description2, 35);
    if (e) return { error: e };
    return {
      asset: {
        finalUrls: a.final_urls,
        sitelinkAsset: { linkText: a.link_text, ...(a.description1 ? { description1: a.description1, description2: a.description2 } : {}) },
      },
    };
  }
  if (kind === "callout") {
    if (!a.callout_text?.trim()) return { error: `${at}: callout_text is required` };
    const e = tooLong("callout_text", a.callout_text, 25);
    if (e) return { error: e };
    return { asset: { calloutAsset: { calloutText: a.callout_text } } };
  }
  if (kind === "structured_snippet") {
    const header = SNIPPET_HEADERS.find((h) => h.toLowerCase() === (a.header ?? "").trim().toLowerCase());
    if (!header) return { error: `${at}.header must be one of: ${SNIPPET_HEADERS.join(", ")}` };
    const values = a.values ?? [];
    if (values.length < 3 || values.length > 10) return { error: `${at}.values: need 3–10, got ${values.length}` };
    for (const v of values) { const e = tooLong("values", v, 25); if (e) return { error: e }; }
    return { asset: { structuredSnippetAsset: { header, values } } };
  }
  if (kind === "price") {
    const type = (a.price_type ?? "").toUpperCase();
    if (!PRICE_TYPES.has(type)) return { error: `${at}.price_type must be one of ${[...PRICE_TYPES].join(", ")}` };
    const q = (a.price_qualifier ?? "").toUpperCase();
    if (q && !PRICE_QUALIFIERS.has(q)) return { error: `${at}.price_qualifier must be FROM | UP_TO | AVERAGE` };
    if (!a.language_code) return { error: `${at}: language_code is required (e.g. en)` };
    if (!a.currency_code) return { error: `${at}: currency_code is required (e.g. THB)` };
    const offers = a.offerings ?? [];
    if (offers.length < 3 || offers.length > 8) return { error: `${at}.offerings: need 3–8, got ${offers.length}` };
    for (const [j, o] of offers.entries()) {
      const e = tooLong(`offerings[${j}].header`, o.header, 25) ?? tooLong(`offerings[${j}].description`, o.description, 25);
      if (e) return { error: e };
      if (!(o.amount > 0)) return { error: `${at}.offerings[${j}].amount must be > 0 (account currency, not micros)` };
      if (!o.final_url) return { error: `${at}.offerings[${j}].final_url is required` };
    }
    return {
      asset: {
        priceAsset: {
          type, ...(q ? { priceQualifier: q } : {}), languageCode: a.language_code,
          priceOfferings: offers.map((o) => ({
            header: o.header, description: o.description, finalUrl: o.final_url,
            price: { currencyCode: a.currency_code, amountMicros: String(Math.round(o.amount * 1_000_000)) },
          })),
        },
      },
    };
  }
  if (kind === "image") {
    if (!a.url) return { error: `${at}: url is required` };
    const res = await fetch(a.url);
    if (!res.ok) return { error: `${at}: download failed ${res.status} ${a.url}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > IMAGE_MAX_BYTES) return { error: `${at}: ${(bytes.length / 1048576).toFixed(1)} MB > 5 MB` };
    const size = imageSize(bytes);
    if (!size) return { error: `${at}: not a JPEG, PNG or GIF` };
    const match = matchImageKind(size.w, size.h, a.image_kind);
    if (match.error) return { error: `${at}: ${match.error}` };
    // Default name carries the size: three crops of one photo must not all be "reception.jpg".
    const base = decodeURIComponent(a.url.split("/").pop() ?? "image").replace(/\?.*$/, "").replace(/\.(jpe?g|png|gif)$/i, "");
    const name = a.name ?? `${base}-${size.w}x${size.h}`;
    return {
      asset: { name, imageAsset: { data: Buffer.from(bytes).toString("base64") } },
      note: { name, size: `${size.w}×${size.h}`, fits: match.kind, bytes: bytes.length },
    };
  }
  return { error: `${at}.kind must be text | sitelink | callout | structured_snippet | price | image` };
}

/**
 * Creates assets (AssetService, create only). Text assets are immutable in
 * Google: to "edit" one, create a new asset and relink it. An unlinked asset is
 * shown nowhere, so this spends nothing. Images are taken by URL: downloaded,
 * checked for format, size and aspect ratio, then sent as bytes.
 */
export async function runCreateAssets(args: {
  account?: string;
  customer_id: string;
  assets: AssetInput[];
  login_customer_id?: string;
  confirm?: boolean;
  validate_only?: boolean;
}): Promise<McpText> {
  try {
    const built: Record<string, unknown>[] = [];
    const notes: Record<string, unknown>[] = [];
    const errors: string[] = [];
    for (const [i, a] of args.assets.entries()) {
      const r = await buildAsset(a, i);
      if (r.error) errors.push(r.error);
      else { built.push(r.asset!); notes.push({ i, kind: a.kind, ...(r.note ?? {}) }); }
    }
    if (errors.length) return asText({ error: "validation failed", problems: errors }, true);

    // The preview must not dump base64 image bytes.
    const preview = built.map((b) =>
      b["imageAsset"] ? { ...b, imageAsset: { data: "<bytes>" } } : b);

    const raw = await runMutation({
      operation: CREATE_TOOL,
      customerId: args.customer_id,
      endpoint: "assets:mutate",
      operations: built.map((create) => ({ create })),
      target: { customer_id: digitsOnly(args.customer_id) },
      change: { count: built.length, assets: args.confirm === true ? notes : preview },
      ...(args.account !== undefined ? { account: args.account } : {}),
      ...(args.login_customer_id !== undefined ? { loginCustomerId: args.login_customer_id } : {}),
      ...(args.confirm !== undefined ? { confirm: args.confirm } : {}),
      ...(args.validate_only !== undefined ? { validate_only: args.validate_only } : {}),
    });
    if (raw.isError) return raw;
    const parsed = JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
    if (args.confirm !== true) {
      // runMutation's preview includes raw operations — replace with the bytes-free version.
      return asText({ ...parsed, operations: preview.map((create) => ({ create })) });
    }
    const results = ((parsed["response"] ?? {}) as { results?: Array<{ resourceName?: string }> }).results ?? [];
    return asText({
      operation: CREATE_TOOL,
      applied: parsed["applied"],
      validated_only: parsed["validated_only"],
      ...(parsed["validated_only"]
        ? { checked: notes }
        : {
            created: results.map((r, i) => ({
              ...notes[i],
              resource_name: r.resourceName,
              asset_id: r.resourceName?.split("/").pop(),
            })),
          }),
    });
  } catch (e) {
    return errorToMcpContent(e) as McpText;
  }
}

// ---------------------------------------------------------------------------
// shared helpers for link tools
// ---------------------------------------------------------------------------

interface LinkInput { asset_id: string; field_type: string }

function summarizePartial(raw: McpText, labels: string[]): McpText {
  const parsed = JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
  const response = (parsed["response"] ?? {}) as {
    results?: Array<{ resourceName?: string }>;
    partialFailureError?: { details?: Array<{ errors?: Array<Record<string, unknown>> }> };
  };
  const rejected: Array<{ op: string; reason: string }> = [];
  for (const d of response.partialFailureError?.details ?? []) {
    for (const e of d.errors ?? []) {
      const loc = (e["location"] as { fieldPathElements?: Array<{ fieldName?: string; index?: number }> } | undefined)
        ?.fieldPathElements?.find((f) => f.fieldName === "operations");
      const code = Object.values((e["errorCode"] ?? {}) as Record<string, string>).join(",");
      rejected.push({
        op: loc?.index !== undefined ? labels[loc.index] ?? `#${loc.index}` : "?",
        reason: `${code}${e["message"] ? `: ${String(e["message"])}` : ""}`,
      });
    }
  }
  return asText({
    operation: parsed["operation"],
    applied: parsed["applied"],
    validated_only: parsed["validated_only"],
    sent: labels.length,
    succeeded: (response.results ?? []).filter((r) => r.resourceName).length,
    rejected_count: rejected.length,
    rejected,
    ...(parsed["via_manager"] ? { via_manager: parsed["via_manager"] } : {}),
  });
}

const norm = (l: LinkInput) => ({ asset_id: digitsOnly(l.asset_id), field_type: l.field_type.trim().toUpperCase() });

// ---------------------------------------------------------------------------
// ads_link_campaign_assets
// ---------------------------------------------------------------------------

/**
 * Links assets to a campaign (sitelinks, callouts, snippets, prices, business
 * name, logos...) and/or unlinks them. partial_failure: a duplicate link is
 * rejected alone and does not sink the batch.
 */
export async function runLinkCampaignAssets(args: {
  account?: string;
  customer_id: string;
  campaign_id: string;
  add?: LinkInput[];
  remove?: LinkInput[];
  login_customer_id?: string;
  confirm?: boolean;
  validate_only?: boolean;
}): Promise<McpText> {
  const cid = digitsOnly(args.customer_id);
  const camp = digitsOnly(args.campaign_id);
  if (!camp) return asText({ error: "campaign_id is required" }, true);
  const add = (args.add ?? []).map(norm);
  const remove = (args.remove ?? []).map(norm);
  if (!add.length && !remove.length) return asText({ error: "pass add and/or remove" }, true);

  const ops = [
    ...remove.map((l) => ({ remove: `customers/${cid}/campaignAssets/${camp}~${l.asset_id}~${l.field_type}` })),
    ...add.map((l) => ({ create: { campaign: `customers/${cid}/campaigns/${camp}`, asset: `customers/${cid}/assets/${l.asset_id}`, fieldType: l.field_type } })),
  ];
  const labels = [
    ...remove.map((l) => `remove ${l.field_type} ${l.asset_id}`),
    ...add.map((l) => `add ${l.field_type} ${l.asset_id}`),
  ];
  const raw = await runMutation({
    operation: CAMPAIGN_LINK_TOOL,
    customerId: args.customer_id,
    endpoint: "campaignAssets:mutate",
    partialFailure: true,
    operations: ops,
    target: { customer_id: cid, campaign_id: camp },
    change: { add: add.length, remove: remove.length, ops: labels },
    ...(args.account !== undefined ? { account: args.account } : {}),
    ...(args.login_customer_id !== undefined ? { loginCustomerId: args.login_customer_id } : {}),
    ...(args.confirm !== undefined ? { confirm: args.confirm } : {}),
    ...(args.validate_only !== undefined ? { validate_only: args.validate_only } : {}),
  });
  if (raw.isError || args.confirm !== true) return raw;
  return summarizePartial(raw, labels);
}

// ---------------------------------------------------------------------------
// ads_link_asset_group_assets
// ---------------------------------------------------------------------------

const GROUP_LIMITS: Record<string, [number, number]> = {
  HEADLINE: [3, 15], LONG_HEADLINE: [1, 5], DESCRIPTION: [2, 5], YOUTUBE_VIDEO: [0, 5],
};
const IMAGE_FIELDS = new Set(["MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "PORTRAIT_MARKETING_IMAGE"]);

/**
 * Adds/removes assets in a PMax asset group in ONE atomic GoogleAds:mutate, so
 * a swap at the limit works: 5 descriptions + remove 1 + add 1 never passes
 * through 6 or 4. Current counts are read first and the result is checked
 * against the group limits before anything is sent. `add` items may carry
 * `text` instead of `asset_id`: the text asset is created in the same request.
 */
export async function runLinkAssetGroupAssets(args: {
  account?: string;
  customer_id: string;
  asset_group_id: string;
  add?: Array<{ asset_id?: string; text?: string; field_type: string }>;
  remove?: LinkInput[];
  login_customer_id?: string;
  confirm?: boolean;
  validate_only?: boolean;
}): Promise<McpText> {
  try {
    const cid = digitsOnly(args.customer_id);
    const ag = digitsOnly(args.asset_group_id);
    if (!ag) return asText({ error: "asset_group_id is required" }, true);
    const add = (args.add ?? []).map((a) => ({ ...a, field_type: a.field_type.trim().toUpperCase(), asset_id: a.asset_id ? digitsOnly(a.asset_id) : undefined }));
    const remove = (args.remove ?? []).map(norm);
    if (!add.length && !remove.length) return asText({ error: "pass add and/or remove" }, true);

    const problems: string[] = [];
    for (const [i, a] of add.entries()) {
      if (!a.asset_id === !a.text) problems.push(`add[${i}]: pass exactly one of asset_id or text`);
      const max = a.text !== undefined ? TEXT_ROLES[a.field_type] : undefined;
      if (a.text !== undefined && max === undefined) problems.push(`add[${i}]: text only for HEADLINE, LONG_HEADLINE, DESCRIPTION, BUSINESS_NAME`);
      if (a.text !== undefined && max !== undefined && len(a.text) > max) problems.push(`add[${i}]: ${a.field_type} ${len(a.text)} > ${max} ("${a.text}")`);
    }

    // Current state of the group: counts per field type and existing links.
    const account = await resolveAccount("google-ads", SCOPE_ADWORDS, args.account);
    const cur = await adsSearch(
      account, cid,
      "SELECT asset.id, asset_group_asset.field_type, asset.text_asset.text FROM asset_group_asset " +
        `WHERE asset_group.id = ${ag} AND asset_group_asset.status != 'REMOVED'`,
      args.login_customer_id,
    );
    if (!cur.ok) return asText({ ok: false, step: "reading asset group", error: cur.error }, true);
    const rows = cur.rows as Array<{ asset?: { id?: string; textAsset?: { text?: string } }; assetGroupAsset?: { fieldType?: string } }>;
    const linked = new Set(rows.map((r) => `${r.asset?.id}~${r.assetGroupAsset?.fieldType}`));
    const texts = new Map(rows.filter((r) => r.asset?.textAsset?.text).map((r) => [`${r.assetGroupAsset?.fieldType}|${r.asset!.textAsset!.text!.toLowerCase()}`, r.asset!.id]));
    const count: Record<string, number> = {};
    for (const r of rows) { const f = r.assetGroupAsset?.fieldType ?? "?"; count[f] = (count[f] ?? 0) + 1; }
    const before = { ...count };

    for (const r of remove) {
      if (!linked.has(`${r.asset_id}~${r.field_type}`)) problems.push(`remove: ${r.field_type} ${r.asset_id} is not in the group`);
      count[r.field_type] = (count[r.field_type] ?? 0) - 1;
    }
    for (const a of add) {
      if (a.asset_id && linked.has(`${a.asset_id}~${a.field_type}`)) problems.push(`add: ${a.field_type} ${a.asset_id} is already in the group`);
      if (a.text !== undefined && texts.has(`${a.field_type}|${a.text.toLowerCase()}`)) problems.push(`add: ${a.field_type} "${a.text}" already in the group (asset ${texts.get(`${a.field_type}|${a.text.toLowerCase()}`)})`);
      count[a.field_type] = (count[a.field_type] ?? 0) + 1;
    }
    for (const [f, [min, max]] of Object.entries(GROUP_LIMITS)) {
      const n = count[f] ?? 0;
      if ((before[f] ?? 0) !== n && (n < min || n > max)) problems.push(`${f}: would become ${n}, allowed ${min}–${max}`);
    }
    const images = [...IMAGE_FIELDS].reduce((s, f) => s + (count[f] ?? 0), 0);
    const imagesBefore = [...IMAGE_FIELDS].reduce((s, f) => s + (before[f] ?? 0), 0);
    if (images !== imagesBefore && images > 20) problems.push(`images: would become ${images}, max 20`);
    if (problems.length) return asText({ error: "validation failed", problems, current: before }, true);

    const P = `customers/${cid}`;
    const AG = `${P}/assetGroups/${ag}`;
    const ops: object[] = [];
    let tmp = -1000;
    const addRefs = add.map((a) => {
      if (a.asset_id) return `${P}/assets/${a.asset_id}`;
      const rn = `${P}/assets/${tmp--}`;
      ops.push({ assetOperation: { create: { resourceName: rn, textAsset: { text: a.text } } } });
      return rn;
    });
    for (const r of remove) {
      ops.push({ assetGroupAssetOperation: { remove: `${AG.replace("/assetGroups/", "/assetGroupAssets/")}~${r.asset_id}~${r.field_type}` } });
    }
    add.forEach((a, i) => ops.push({ assetGroupAssetOperation: { create: { assetGroup: AG, asset: addRefs[i], fieldType: a.field_type } } }));

    return runMutation({
      operation: GROUP_LINK_TOOL,
      customerId: args.customer_id,
      endpoint: "googleAds:mutate",
      operationsKey: "mutateOperations",
      operations: ops,
      target: { customer_id: cid, asset_group_id: ag },
      change: {
        remove: remove.map((r) => `${r.field_type} ${r.asset_id}`),
        add: add.map((a) => `${a.field_type} ${a.asset_id ?? `"${a.text}" (new)`}`),
        counts_before: before,
        counts_after: Object.fromEntries(Object.entries(count).filter(([, n]) => n !== 0)),
        atomic: true,
      },
      ...(args.account !== undefined ? { account: args.account } : {}),
      ...(args.login_customer_id !== undefined ? { loginCustomerId: args.login_customer_id } : {}),
      ...(args.confirm !== undefined ? { confirm: args.confirm } : {}),
      ...(args.validate_only !== undefined ? { validate_only: args.validate_only } : {}),
    });
  } catch (e) {
    return errorToMcpContent(e) as McpText;
  }
}
