#!/usr/bin/env node
/**
 * ShipAgent MCP Server
 * Exposes ShipAgent domain registration and deployment as MCP tools.
 *
 * Usage: node mcp-server.js
 * Config: set SHIPAGENT_API env var to override API base URL (default: http://127.0.0.1:3001)
 */

"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const API_BASE = (process.env.SHIPAGENT_API || "http://127.0.0.1:3001").replace(/\/$/, "");

// --- HTTP helper ---

function apiRequest(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...(headers || {}),
      },
    };

    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function formatResult(response) {
  const { status, body } = response;

  if (status === 402) {
    // x402 payment required — give the agent everything it needs
    const paymentInfo = response.headers["x-payment-required"] || response.headers["payment-required"];
    let paymentDetails = {};
    if (paymentInfo) {
      try {
        paymentDetails = JSON.parse(Buffer.from(paymentInfo, "base64").toString());
      } catch {
        paymentDetails = { raw: paymentInfo };
      }
    }
    return {
      isError: false,
      content: [{
        type: "text",
        text: JSON.stringify({
          paymentRequired: true,
          statusCode: 402,
          message: "x402 payment required. Sign a USDC authorization and retry with X-Payment header.",
          paymentDetails,
          bodyDetails: body,
        }, null, 2),
      }],
    };
  }

  if (status >= 400) {
    const msg = (typeof body === "object" && body.error) ? body.error : JSON.stringify(body);
    return { isError: true, content: [{ type: "text", text: `Error ${status}: ${msg}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: "domainagent_auth_challenge",
    description:
      "Get a challenge message to sign with your wallet. First step of authentication. Returns a message containing a nonce that must be signed.",
    inputSchema: {
      type: "object",
      required: ["owner"],
      properties: {
        owner: { type: "string", description: "Wallet address (0x...)" },
      },
    },
  },
  {
    name: "domainagent_auth_verify",
    description:
      "Verify a signed challenge and get a session token. Second step of authentication. Use the token as Bearer auth for subsequent calls.",
    inputSchema: {
      type: "object",
      required: ["owner", "signature", "message"],
      properties: {
        owner: { type: "string", description: "Wallet address" },
        signature: { type: "string", description: "Signature of the challenge message" },
        message: { type: "string", description: "The exact challenge message that was signed" },
      },
    },
  },
  {
    name: "domainagent_list_domains",
    description:
      "List all domains owned by the authenticated wallet. Requires auth token.",
    inputSchema: {
      type: "object",
      properties: {
        authToken: { type: "string", description: "Session token from auth/verify" },
      },
      required: ["authToken"],
    },
  },
  {
    name: "domainagent_health",
    description:
      "Check if a deployed domain is healthy — DNS resolution, HTTP status, SSL, response time. Free, no auth required.",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: {
        domain: { type: "string", description: "Domain to health-check (e.g. fittrack.dev)" },
      },
    },
  },
  {
    name: "domainagent_dns_list",
    description:
      "List DNS records for a domain. Requires auth.",
    inputSchema: {
      type: "object",
      required: ["domain", "authToken"],
      properties: {
        domain: { type: "string", description: "Domain name" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_dns_add",
    description:
      "Add a DNS record (MX, TXT, CNAME, A, etc.) to a domain. Requires auth.",
    inputSchema: {
      type: "object",
      required: ["domain", "type", "answer", "authToken"],
      properties: {
        domain: { type: "string", description: "Domain name" },
        host: { type: "string", description: "Subdomain or empty for apex" },
        type: { type: "string", description: "Record type (A, CNAME, MX, TXT, etc.)" },
        answer: { type: "string", description: "Record value" },
        ttl: { type: "number", description: "TTL in seconds (default 300)" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_dns_delete",
    description:
      "Delete a DNS record by ID. Get record IDs from domainagent_dns_list. Requires auth.",
    inputSchema: {
      type: "object",
      required: ["domain", "recordId", "authToken"],
      properties: {
        domain: { type: "string", description: "Domain name" },
        recordId: { type: "string", description: "DNS record ID to delete" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_renewal_email",
    description:
      "Set a renewal reminder email address for a domain. We'll email 30 days before expiry. Requires auth.",
    inputSchema: {
      type: "object",
      required: ["domain", "email", "authToken"],
      properties: {
        domain: { type: "string", description: "Domain name" },
        email: { type: "string", description: "Email address for renewal reminders" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_connect",
    description:
      "Connect a Cloudflare account so deployments go to the customer's own infrastructure. One-time setup. Requires a Cloudflare API token with Pages:Edit and DNS:Edit permissions. Requires auth.",
    inputSchema: {
      type: "object",
      required: ["cf_api_token", "authToken"],
      properties: {
        cf_api_token: { type: "string", description: "Cloudflare API token with Pages:Edit and DNS:Edit permissions" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_transfer_out",
    description:
      "Get an auth/EPP code to transfer a domain to another registrar. Free — no charge. The domain will be unlocked and the auth code returned. Requires auth.",
    inputSchema: {
      type: "object",
      required: ["domain", "authToken"],
      properties: {
        domain: { type: "string", description: "Domain to transfer out (e.g. fittrack.dev)" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_renewals_due",
    description:
      "Check which domains are expiring within 30 days. Free. Optionally filter by owner wallet.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Filter by wallet address (optional)" },
      },
    },
  },
  {
    name: "domainagent_renew",
    description:
      "Renew a domain registration. Protected by x402 — costs domain renewal price + $2 fee in USDC.",
    inputSchema: {
      type: "object",
      required: ["domain", "owner"],
      properties: {
        domain: { type: "string", description: "Domain to renew" },
        owner: { type: "string", description: "Wallet address of the domain owner" },
        paymentSignature: { type: "string", description: "x402 payment signature (after receiving payment details)" },
      },
    },
  },
  {
    name: "domainagent_search",
    description:
      "Search for available domain names matching a keyword or phrase. Returns domain availability and pricing. Use this before deploying to find a good domain.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Keyword or phrase to search for (e.g. 'fitness app', 'fittrack')",
        },
        tlds: {
          type: "array",
          description: "TLDs to search. Default: .com, .dev, .io, .app, .net, .xyz, .co",
          items: { type: "string" },
          example: [".com", ".dev"],
        },
      },
    },
  },
  {
    name: "domainagent_recommend",
    description:
      "Get AI-powered domain suggestions based on a natural language description of your project. Extracts keywords and searches for the best available options within your budget.",
    inputSchema: {
      type: "object",
      required: ["description"],
      properties: {
        description: {
          type: "string",
          description: "Natural language description of your project (e.g. 'a fitness tracking app for runners')",
        },
        budget: {
          type: "number",
          description: "Maximum domain price in USD (default: 100)",
        },
      },
    },
  },
  {
    name: "domainagent_pricing",
    description:
      "Get the current TLD price list and fee structure for deploying via ShipAgent. Returns domain registration costs by TLD, plus deploy and redeploy fees.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "domainagent_status",
    description:
      "Check the registration, deployment, DNS, and SSL status of a domain deployed through ShipAgent.",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: {
        domain: {
          type: "string",
          description: "Domain to check status for (e.g. fittrack.dev)",
        },
      },
    },
  },
  {
    name: "domainagent_deploy",
    description: `Register a domain and deploy your app in one call.
This endpoint is protected by x402 — you will receive payment details first.

Steps:
1. Call this tool with your domain, owner address, and base64-encoded zip file
2. If x402 payment is required, you'll receive payment details (amount, recipient, network)
3. Sign a USDC authorization on Base mainnet
4. Retry with your signed payment header

The tool handles:
- Domain availability check
- Domain registration via Name.com
- Deployment to Cloudflare Pages
- DNS configuration
- SSL (automatic via Cloudflare)

Your zip file must contain a static site with index.html at the root.`,
    inputSchema: {
      type: "object",
      required: ["domain", "owner", "filesBase64"],
      properties: {
        domain: {
          type: "string",
          description: "Domain to register and deploy to (e.g. fittrack.dev)",
        },
        owner: {
          type: "string",
          description: "Your wallet address (used for ownership verification on redeployment)",
        },
        filesBase64: {
          type: "string",
          description: "Base64-encoded zip file of your static site (must include index.html at root)",
        },
        paymentSignature: {
          type: "string",
          description: "x402 payment signature (X-Payment header value) from a signed USDC authorization. Required after receiving payment details.",
        },
      },
    },
  },
  {
    name: "domainagent_redeploy",
    description: `Update an existing ShipAgent deployment with new files.
The domain must already be registered via domainagent_deploy.
Costs $2 USDC via x402 payment.

Steps:
1. Call this tool with your domain, owner address, and updated zip file
2. Receive x402 payment details
3. Sign USDC authorization and retry with payment signature`,
    inputSchema: {
      type: "object",
      required: ["domain", "owner", "filesBase64"],
      properties: {
        domain: {
          type: "string",
          description: "Domain to redeploy (must already be deployed)",
        },
        owner: {
          type: "string",
          description: "Your wallet address (must match original deployer)",
        },
        filesBase64: {
          type: "string",
          description: "Base64-encoded zip file with updated static site",
        },
        paymentSignature: {
          type: "string",
          description: "x402 payment signature after receiving payment details",
        },
      },
    },
  },
  {
    name: "domainagent_hosting_status",
    description:
      "Check hosting status, tier, usage, and billing info for a deployed domain.",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: {
        domain: { type: "string", description: "Domain to check hosting for" },
      },
    },
  },
  {
    name: "domainagent_hosting_pay",
    description:
      "Pay hosting fee for a domain. Protected by x402. Send tier (starter/growth/pro) and billing (monthly/annual). Also resumes paused sites.",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: {
        domain: { type: "string", description: "Domain to pay hosting for" },
        tier: { type: "string", description: "Hosting tier: starter, growth, or pro (default: current tier)" },
        billing: { type: "string", description: "Billing cycle: monthly or annual (default: monthly)" },
        paymentSignature: { type: "string", description: "x402 payment signature" },
      },
    },
  },
  {
    name: "domainagent_hosting_pay_overage",
    description:
      "Pay outstanding bandwidth overage for a domain. Protected by x402. Amount is calculated from actual usage. Also resumes paused sites.",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: {
        domain: { type: "string", description: "Domain with outstanding overage" },
        paymentSignature: { type: "string", description: "x402 payment signature" },
      },
    },
  },
  {
    name: "domainagent_hosting_upgrade",
    description:
      "Upgrade the hosting tier for a domain. Requires auth. Does not charge — use domainagent_hosting_pay to pay for the new tier.",
    inputSchema: {
      type: "object",
      required: ["domain", "tier", "authToken"],
      properties: {
        domain: { type: "string", description: "Domain to upgrade" },
        tier: { type: "string", description: "New tier: starter, growth, or pro" },
        billing: { type: "string", description: "Billing cycle: monthly or annual" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_env_list",
    description:
      "List environment variable names (values masked) for a deployed domain. Requires auth.",
    inputSchema: {
      type: "object",
      required: ["domain", "authToken"],
      properties: {
        domain: { type: "string", description: "Domain to list env vars for" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_env_set",
    description:
      "Set one or more environment variables for a deployed domain. Restarts the app automatically. Requires auth.",
    inputSchema: {
      type: "object",
      required: ["domain", "vars", "authToken"],
      properties: {
        domain: { type: "string", description: "Domain to set env vars for" },
        vars: { type: "object", description: "Key-value pairs to set, e.g. { DATABASE_URL: 'postgres://...' }" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_env_delete",
    description:
      "Delete an environment variable by key from a deployed domain. Restarts the app automatically. Requires auth.",
    inputSchema: {
      type: "object",
      required: ["domain", "key", "authToken"],
      properties: {
        domain: { type: "string", description: "Domain to delete env var from" },
        key: { type: "string", description: "Environment variable key to delete" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_logs",
    description:
      "Fetch recent logs for a deployed domain. Only available for Fly-hosted apps. Requires auth.",
    inputSchema: {
      type: "object",
      required: ["domain", "authToken"],
      properties: {
        domain: { type: "string", description: "Domain to fetch logs for" },
        lines: { type: "number", description: "Number of log lines to return (default: 100)" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_deploy_preview",
    description:
      "Deploy files to a preview URL without a custom domain. Good for testing before going live. Protected by x402 — $2 fee.",
    inputSchema: {
      type: "object",
      required: ["owner", "filesBase64"],
      properties: {
        owner: { type: "string", description: "Wallet address" },
        domain: { type: "string", description: "Optional domain to associate the preview with" },
        hostingTier: { type: "string", description: "Hosting tier (default: starter)" },
        filesBase64: { type: "string", description: "Base64-encoded zip file of your site" },
        paymentSignature: { type: "string", description: "x402 payment signature" },
      },
    },
  },
  {
    name: "domainagent_deploy_promote",
    description:
      "Promote a preview deployment to production on a custom domain. Requires auth.",
    inputSchema: {
      type: "object",
      required: ["domain", "previewId", "authToken"],
      properties: {
        domain: { type: "string", description: "Domain to promote the preview to" },
        previewId: { type: "string", description: "Preview app ID from domainagent_deploy_preview" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_rollback",
    description:
      "Roll back a domain to its previous deployment. Requires at least 2 deploys in history. Requires auth.",
    inputSchema: {
      type: "object",
      required: ["domain", "authToken"],
      properties: {
        domain: { type: "string", description: "Domain to roll back" },
        authToken: { type: "string", description: "Session token" },
      },
    },
  },
  {
    name: "domainagent_deploy_from_git",
    description:
      "Deploy directly from a GitHub repo URL. Clones the repo, auto-detects runtime (Node.js, Python, Docker, static), builds, and deploys. Protected by x402 — $2 fee.",
    inputSchema: {
      type: "object",
      required: ["domain", "repoUrl", "owner", "email"],
      properties: {
        domain: { type: "string", description: "Domain to deploy to" },
        repoUrl: { type: "string", description: "Git repository URL (e.g. https://github.com/user/repo)" },
        branch: { type: "string", description: "Branch to deploy (default: main)" },
        owner: { type: "string", description: "Wallet address" },
        email: { type: "string", description: "Contact email for hosting notices" },
        hostingTier: { type: "string", description: "Hosting tier (default: starter)" },
        hostingBilling: { type: "string", description: "Billing cycle: monthly or annual" },
        paymentSignature: { type: "string", description: "x402 payment signature" },
      },
    },
  },
];

// --- Multipart form builder (for file upload endpoints) ---

function buildMultipartForm(fields, fileFieldName, fileBuffer, fileName) {
  const boundary = `----ShipAgentBoundary${Date.now()}`;
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value == null) continue;
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    );
  }

  if (fileBuffer) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; filename="${fileName || "files.zip"}"\r\nContent-Type: application/zip\r\n\r\n`
    );
  }

  const textPart = Buffer.from(parts.join(""));
  const endPart = Buffer.from(`\r\n--${boundary}--\r\n`);

  let body;
  if (fileBuffer) {
    body = Buffer.concat([textPart, fileBuffer, endPart]);
  } else {
    body = Buffer.concat([textPart, endPart]);
  }

  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function multipartRequest(method, path, fields, fileBuffer, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    const { body, contentType } = buildMultipartForm(
      fields,
      "files",
      fileBuffer,
      "files.zip"
    );

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": contentType,
        "Content-Length": body.length,
        "Accept": "application/json",
        ...(extraHeaders || {}),
      },
    };

    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// --- Tool handlers ---

async function handleTool(name, args) {
  switch (name) {
    case "domainagent_auth_challenge": {
      const res = await apiRequest("POST", "/api/auth/challenge", { owner: args.owner });
      return formatResult(res);
    }

    case "domainagent_auth_verify": {
      const res = await apiRequest("POST", "/api/auth/verify", {
        owner: args.owner,
        signature: args.signature,
        message: args.message,
      });
      return formatResult(res);
    }

    case "domainagent_list_domains": {
      const res = await apiRequest("GET", "/api/domains", null, {
        Authorization: `Bearer ${args.authToken}`,
      });
      return formatResult(res);
    }

    case "domainagent_health": {
      const res = await apiRequest("GET", `/api/health/${encodeURIComponent(args.domain)}`);
      return formatResult(res);
    }

    case "domainagent_dns_list": {
      const res = await apiRequest("GET", `/api/dns/${encodeURIComponent(args.domain)}`, null, {
        Authorization: `Bearer ${args.authToken}`,
      });
      return formatResult(res);
    }

    case "domainagent_dns_add": {
      const res = await apiRequest("POST", `/api/dns/${encodeURIComponent(args.domain)}`, {
        host: args.host || "",
        type: args.type,
        answer: args.answer,
        ttl: args.ttl || 300,
      }, { Authorization: `Bearer ${args.authToken}` });
      return formatResult(res);
    }

    case "domainagent_dns_delete": {
      const res = await apiRequest("DELETE", `/api/dns/${encodeURIComponent(args.domain)}/${args.recordId}`, null, {
        Authorization: `Bearer ${args.authToken}`,
      });
      return formatResult(res);
    }

    case "domainagent_renewal_email": {
      const res = await apiRequest("POST", "/api/renewal-email", {
        domain: args.domain,
        email: args.email,
      }, { Authorization: `Bearer ${args.authToken}` });
      return formatResult(res);
    }

    case "domainagent_connect": {
      const res = await apiRequest("POST", "/api/connect", {
        cf_api_token: args.cf_api_token,
      }, { Authorization: `Bearer ${args.authToken}` });
      return formatResult(res);
    }

    case "domainagent_transfer_out": {
      const res = await apiRequest("POST", "/api/transfer-out", {
        domain: args.domain,
      }, { Authorization: `Bearer ${args.authToken}` });
      return formatResult(res);
    }

    case "domainagent_renewals_due": {
      const ownerParam = args.owner ? `?owner=${encodeURIComponent(args.owner)}` : "";
      const res = await apiRequest("GET", `/api/renewals-due${ownerParam}`);
      return formatResult(res);
    }

    case "domainagent_renew": {
      const extraHeaders = {};
      if (args.paymentSignature) extraHeaders["X-Payment"] = args.paymentSignature;
      const res = await apiRequest("POST", "/api/renew", {
        domain: args.domain,
        owner: args.owner,
      }, extraHeaders);
      return formatResult(res);
    }

    case "domainagent_search": {
      const res = await apiRequest("POST", "/api/search", {
        query: args.query,
        tlds: args.tlds,
      });
      return formatResult(res);
    }

    case "domainagent_recommend": {
      const res = await apiRequest("POST", "/api/recommend", {
        description: args.description,
        budget: args.budget,
      });
      return formatResult(res);
    }

    case "domainagent_pricing": {
      const res = await apiRequest("GET", "/api/pricing");
      return formatResult(res);
    }

    case "domainagent_status": {
      const domain = encodeURIComponent(args.domain);
      const res = await apiRequest("GET", `/api/status/${domain}`);
      return formatResult(res);
    }

    case "domainagent_deploy": {
      const { domain, owner, filesBase64, paymentSignature } = args;

      let fileBuffer = null;
      if (filesBase64) {
        try {
          fileBuffer = Buffer.from(filesBase64, "base64");
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Invalid base64 for filesBase64: ${err.message}` }],
          };
        }
      }

      const extraHeaders = {};
      if (paymentSignature) {
        extraHeaders["X-Payment"] = paymentSignature;
      }

      const res = await multipartRequest(
        "POST",
        "/api/deploy",
        { domain, owner },
        fileBuffer,
        extraHeaders
      );

      return formatResult(res);
    }

    case "domainagent_redeploy": {
      const { domain, owner, filesBase64, paymentSignature } = args;

      let fileBuffer = null;
      if (filesBase64) {
        try {
          fileBuffer = Buffer.from(filesBase64, "base64");
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Invalid base64 for filesBase64: ${err.message}` }],
          };
        }
      }

      const extraHeaders = {};
      if (paymentSignature) {
        extraHeaders["X-Payment"] = paymentSignature;
      }

      const res = await multipartRequest(
        "POST",
        "/api/redeploy",
        { domain, owner },
        fileBuffer,
        extraHeaders
      );

      return formatResult(res);
    }

    case "domainagent_hosting_status": {
      const res = await apiRequest("GET", `/api/hosting/${encodeURIComponent(args.domain)}`);
      return formatResult(res);
    }

    case "domainagent_hosting_pay": {
      const extraHeaders = {};
      if (args.paymentSignature) extraHeaders["X-Payment"] = args.paymentSignature;
      const res = await apiRequest("POST", "/api/hosting/pay", {
        domain: args.domain,
        tier: args.tier,
        billing: args.billing,
      }, extraHeaders);
      return formatResult(res);
    }

    case "domainagent_hosting_pay_overage": {
      const extraHeaders = {};
      if (args.paymentSignature) extraHeaders["X-Payment"] = args.paymentSignature;
      const res = await apiRequest("POST", "/api/hosting/pay-overage", {
        domain: args.domain,
      }, extraHeaders);
      return formatResult(res);
    }

    case "domainagent_hosting_upgrade": {
      const res = await apiRequest("POST", `/api/hosting/${encodeURIComponent(args.domain)}/upgrade`, {
        tier: args.tier,
        billing: args.billing,
      }, { Authorization: `Bearer ${args.authToken}` });
      return formatResult(res);
    }

    case "domainagent_env_list": {
      const res = await apiRequest("GET", `/api/hosting/${encodeURIComponent(args.domain)}/env`, null, {
        Authorization: `Bearer ${args.authToken}`,
      });
      return formatResult(res);
    }

    case "domainagent_env_set": {
      const res = await apiRequest("POST", `/api/hosting/${encodeURIComponent(args.domain)}/env`, {
        vars: args.vars,
      }, { Authorization: `Bearer ${args.authToken}` });
      return formatResult(res);
    }

    case "domainagent_env_delete": {
      const res = await apiRequest("DELETE", `/api/hosting/${encodeURIComponent(args.domain)}/env/${encodeURIComponent(args.key)}`, null, {
        Authorization: `Bearer ${args.authToken}`,
      });
      return formatResult(res);
    }

    case "domainagent_logs": {
      const linesParam = args.lines ? `?lines=${args.lines}` : "";
      const res = await apiRequest("GET", `/api/hosting/${encodeURIComponent(args.domain)}/logs${linesParam}`, null, {
        Authorization: `Bearer ${args.authToken}`,
      });
      return formatResult(res);
    }

    case "domainagent_deploy_preview": {
      const { owner, domain, hostingTier, filesBase64, paymentSignature } = args;

      let fileBuffer = null;
      if (filesBase64) {
        try {
          fileBuffer = Buffer.from(filesBase64, "base64");
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: `Invalid base64 for filesBase64: ${err.message}` }],
          };
        }
      }

      const extraHeaders = {};
      if (paymentSignature) extraHeaders["X-Payment"] = paymentSignature;

      const fields = { owner };
      if (domain) fields.domain = domain;
      if (hostingTier) fields.hostingTier = hostingTier;

      const res = await multipartRequest(
        "POST",
        "/api/deploy/preview",
        fields,
        fileBuffer,
        extraHeaders
      );

      return formatResult(res);
    }

    case "domainagent_deploy_promote": {
      const res = await apiRequest("POST", "/api/deploy/promote", {
        domain: args.domain,
        previewId: args.previewId,
      }, { Authorization: `Bearer ${args.authToken}` });
      return formatResult(res);
    }

    case "domainagent_rollback": {
      const res = await apiRequest("POST", `/api/hosting/${encodeURIComponent(args.domain)}/rollback`, null, {
        Authorization: `Bearer ${args.authToken}`,
      });
      return formatResult(res);
    }

    case "domainagent_deploy_from_git": {
      const extraHeaders = {};
      if (args.paymentSignature) extraHeaders["X-Payment"] = args.paymentSignature;
      const res = await apiRequest("POST", "/api/deploy/from-git", {
        domain: args.domain,
        repoUrl: args.repoUrl,
        branch: args.branch,
        owner: args.owner,
        email: args.email,
        hostingTier: args.hostingTier,
        hostingBilling: args.hostingBilling,
      }, extraHeaders);
      return formatResult(res);
    }

    default:
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
  }
}

// --- MCP server setup ---

async function main() {
  const server = new Server(
    { name: "domainagent", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleTool(name, args || {});
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Tool error: ${err.message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`domainagent MCP server running (API: ${API_BASE})\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
