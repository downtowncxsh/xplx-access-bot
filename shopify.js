// shopify.js
require("dotenv").config();

const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN, SHOPIFY_API_VERSION } =
  process.env;

function assertEnv() {
  const missing = [];
  if (!SHOPIFY_STORE_DOMAIN) missing.push("SHOPIFY_STORE_DOMAIN");
  if (!SHOPIFY_ADMIN_ACCESS_TOKEN) missing.push("SHOPIFY_ADMIN_ACCESS_TOKEN");
  if (!SHOPIFY_API_VERSION) missing.push("SHOPIFY_API_VERSION");
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}`);
  }
}

async function shopifyGraphQL(query, variables = {}) {
  assertEnv();

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

/**
 * Returns paid line items with subscription info.
 * Each item: { title, isSubscription, sellingPlanName }
 */
async function getPaidLineItemsByEmail(email) {
  const q = `email:${email} financial_status:paid`;

  const query = `
    query OrdersByEmail($first: Int!, $query: String!) {
      orders(first: $first, query: $query, reverse: true) {
        nodes {
          id
          createdAt
          displayFinancialStatus
          lineItems(first: 50) {
            nodes {
              title
              sellingPlan {
                name
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { first: 10, query: q });
  const orders = data?.orders?.nodes ?? [];

  const items = [];
  for (const order of orders) {
    for (const li of order.lineItems.nodes) {
      const planName = li?.sellingPlan?.name || null;
      items.push({
        title: li.title,
        isSubscription: !!planName,
        sellingPlanName: planName,
      });
    }
  }
  return items;
}

// Backward compatible: your bot still uses this
async function getPaidProductTitlesByEmail(email) {
  const items = await getPaidLineItemsByEmail(email);
  return items.map((x) => x.title);
}

module.exports = { getPaidProductTitlesByEmail, getPaidLineItemsByEmail };
