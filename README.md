# domainagent-mcp

MCP server for [domainagent.dev](https://domainagent.dev) — the domain registrar built for AI agents.

Search, register, deploy, and manage domains in one prompt. Pay with USDC on Base via x402.

## What is domainagent?

domainagent is an agent-first domain registrar. Instead of clicking through GoDaddy, your AI agent calls an API and gets:

- **Domain search + registration** via Name.com
- **Static site deployment** via Cloudflare Pages
- **DNS management** (A, CNAME, MX, TXT records)
- **SSL** (automatic via Cloudflare)
- **Health checks** (DNS, HTTP, SSL, response time)
- **Renewals** with expiry tracking
- **Free transfer-out** with auth/EPP codes (no lock-in)
- **x402 payment** — USDC on Base mainnet, no credit card needed

## Install

### npx (no install)
```bash
npx domainagent-mcp
```

### Claude Desktop / Cursor / MCP-compatible tools

Add to your MCP config:

```json
{
  "mcpServers": {
    "domainagent": {
      "command": "npx",
      "args": ["domainagent-mcp"],
      "env": {
        "SHIPAGENT_API": "https://domainagent.dev"
      }
    }
  }
}
```

### Global install
```bash
npm install -g domainagent-mcp
domainagent-mcp
```

## Tools

| Tool | Description | Auth | Payment |
|------|-------------|------|---------|
| `domainagent_search` | Search available domains | — | Free |
| `domainagent_recommend` | AI domain suggestions from a description | — | Free |
| `domainagent_pricing` | TLD price list | — | Free |
| `domainagent_status` | Check domain deployment status | — | Free |
| `domainagent_health` | DNS + HTTP + SSL health check | — | Free |
| `domainagent_renewals_due` | Domains expiring within 30 days | — | Free |
| `domainagent_deploy` | Register + deploy + DNS + SSL | Wallet | x402 USDC |
| `domainagent_redeploy` | Update existing deployment | Wallet | x402 USDC |
| `domainagent_renew` | Renew domain registration | Wallet | x402 USDC |
| `domainagent_auth_challenge` | Get wallet auth challenge | — | Free |
| `domainagent_auth_verify` | Verify signed challenge → session token | — | Free |
| `domainagent_list_domains` | List your domains | Token | Free |
| `domainagent_dns_list` | List DNS records | Token | Free |
| `domainagent_dns_add` | Add DNS record | Token | Free |
| `domainagent_dns_delete` | Delete DNS record | Token | Free |
| `domainagent_renewal_email` | Set renewal reminder email | Token | Free |
| `domainagent_connect` | Connect your Cloudflare account | Token | Free |
| `domainagent_transfer_out` | Get auth/EPP code for transfer | Token | Free |

## Hosting Plans

| Tier | Monthly | Bandwidth | Type | Overage | Auto-pause |
|------|---------|-----------|------|---------|------------|
| starter | $3/mo | 5 GB | Static (CF Pages) | $0.50/GB | At limit |
| growth | $8/mo | 25 GB | Static (CF Pages) | $0.50/GB | At limit |
| pro | $20/mo | 100 GB | Static (CF Pages) | $0.50/GB | At limit |
| app_sm | $12/mo | 25 GB | App (Fly.io) | $0.50/GB | At limit |
| app_md | $25/mo | 50 GB | App (Fly.io) | $0.50/GB | At limit |
| app_lg | $50/mo | 100 GB | App (Fly.io) | $0.50/GB | At limit |

**Bandwidth enforcement:** At 80% you'll get an email warning. At 100% your site pauses automatically — no surprise bills. Bandwidth is tracked in real-time via the Fly.io GraphQL API.

## Quick Start

**Search for a domain:**
```
"Find me a domain for my fitness tracking app"
→ domainagent_search({ query: "fitness tracker" })
→ fittrack.dev — $14.99 (available)
```

**Deploy:**
```
"Deploy my app to fittrack.dev"
→ domainagent_deploy({ domain: "fittrack.dev", owner: "0x...", filesBase64: "..." })
→ 402 Payment Required: $16.99 USDC (domain + deploy fee)
→ Agent signs USDC authorization, retries
→ ✓ fittrack.dev is live with SSL
```

**Check health:**
```
"Is fittrack.dev working?"
→ domainagent_health({ domain: "fittrack.dev" })
→ DNS: ✓ | HTTP: 200 | SSL: valid | Response: 45ms
```

## Authentication

Free tools (search, pricing, health) require no auth.

Sensitive operations use wallet-based authentication:
1. Call `domainagent_auth_challenge` with your wallet address
2. Sign the returned message with your wallet
3. Call `domainagent_auth_verify` with the signature
4. Use the returned session token as `authToken` in subsequent calls

Paid operations (deploy, redeploy, renew) use x402 — sign a USDC authorization on Base mainnet.

## x402 Payment Flow

Paid endpoints return `402 Payment Required` with details:
- Network: Base mainnet (eip155:8453)
- Token: USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- Amount: varies by operation

Your agent signs a USDC authorization and retries with the `X-Payment` header. The [x402 protocol](https://www.x402.org/) handles the rest.

## No Lock-in

- **Free transfer-out** — get your auth/EPP code anytime via `domainagent_transfer_out`
- **You own your domain** — registered in your name via Name.com (ICANN-accredited)
- **Connect your own Cloudflare** — deploy to your infrastructure, not ours
- **Open MCP** — this repo is MIT licensed

## x402 Payment Signing

Some MCP tools (deploy, redeploy, renew) require x402 USDC payment on Base mainnet.

The `examples/` directory includes tools to make this easy:

### x402-signer.js

Signs x402 payment headers from your wallet. Use it when an MCP tool returns a 402:

```bash
# Install dependencies
npm install viem @x402/core @x402/evm

# Sign a payment from a saved 402 response
node examples/x402-signer.js --payment-file payment-402.json --key 0xYOUR_KEY

# Or pipe it
echo '{"paymentDetails":{...}}' | node examples/x402-signer.js --key 0xYOUR_KEY

# Use with env var
export WALLET_PRIVATE_KEY=0x...
node examples/x402-signer.js --payment-file payment-402.json
```

Output: a base64-encoded `PAYMENT-SIGNATURE` value ready to pass as `paymentSignature` in any MCP tool.

### Full deploy flow example

```bash
export WALLET_PRIVATE_KEY=0x...
export WALLET_ADDRESS=0x...
export CONTACT_EMAIL=you@example.com

./examples/agent-deploy-flow.sh mydomain.xyz ./my-site.zip
```

This script handles the complete flow: search → deploy attempt → sign payment → retry with signature → verify status.

## API

Full OpenAPI spec: [domainagent.dev/openapi.yaml](https://domainagent.dev/openapi.yaml)

Agent discovery: [domainagent.dev/.well-known/agent.json](https://domainagent.dev/.well-known/agent.json)

## License

MIT
