#!/usr/bin/env node

/**
 * x402 Payment Signer for domainagent
 *
 * Signs x402 payment headers for domainagent MCP tools that require USDC payment.
 * Works with any EVM wallet private key on Base mainnet.
 *
 * Usage:
 *   # Sign a payment from a 402 response saved to a file:
 *   node x402-signer.js --payment-file payment-required.json --key 0xYOUR_PRIVATE_KEY
 *
 *   # Or pipe the 402 JSON directly:
 *   echo '{"paymentDetails":{...}}' | node x402-signer.js --key 0xYOUR_PRIVATE_KEY
 *
 *   # Use with environment variable:
 *   export WALLET_PRIVATE_KEY=0x...
 *   node x402-signer.js --payment-file payment-required.json
 *
 * Output: the base64-encoded PAYMENT-SIGNATURE header value, ready to pass as
 *         `paymentSignature` in any domainagent MCP tool call.
 *
 * Requirements:
 *   npm install viem @x402/core @x402/evm
 */

const fs = require("fs");
const { x402Client } = require("@x402/core/client");
const { x402HTTPClient } = require("@x402/core/http");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { privateKeyToAccount } = require("viem/accounts");
const { createWalletClient, createPublicClient, http } = require("viem");
const { base } = require("viem/chains");

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

function usage() {
  console.error(`
x402 Payment Signer for domainagent

Signs USDC payment authorizations for x402-protected endpoints.

Usage:
  node x402-signer.js --payment-file <path> [--key <private-key>]
  cat payment-required.json | node x402-signer.js [--key <private-key>]

Options:
  --payment-file <path>   Path to JSON file containing 402 response (with paymentDetails)
  --key <hex>             Wallet private key (or set WALLET_PRIVATE_KEY env var)
  --json                  Output full JSON instead of just the signature string

Environment:
  WALLET_PRIVATE_KEY      Fallback private key if --key not provided
  BASE_RPC_URL            Custom Base RPC endpoint (default: https://mainnet.base.org)

The input JSON should have this shape (from a domainagent 402 response):
  {
    "paymentDetails": {
      "x402Version": 2,
      "accepts": [{ "scheme": "exact", "network": "eip155:8453", ... }],
      ...
    }
  }

Output: base64-encoded PAYMENT-SIGNATURE value to use as paymentSignature in MCP tools.
`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  let paymentFile = null;
  let privateKey = process.env.WALLET_PRIVATE_KEY;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--payment-file" && args[i + 1]) {
      paymentFile = args[++i];
    } else if (args[i] === "--key" && args[i + 1]) {
      privateKey = args[++i];
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      usage();
    }
  }

  if (!privateKey) {
    console.error("Error: No private key provided. Use --key or set WALLET_PRIVATE_KEY.");
    process.exit(1);
  }

  // Read payment required JSON
  let rawInput;
  if (paymentFile) {
    rawInput = fs.readFileSync(paymentFile, "utf8");
  } else if (!process.stdin.isTTY) {
    rawInput = fs.readFileSync("/dev/stdin", "utf8");
  } else {
    console.error("Error: No payment data provided. Use --payment-file or pipe JSON to stdin.");
    usage();
  }

  let paymentRequired;
  try {
    const parsed = JSON.parse(rawInput);
    // Accept either the full 402 response or just the paymentDetails
    paymentRequired = parsed.paymentDetails || parsed;
  } catch (e) {
    console.error("Error: Invalid JSON input:", e.message);
    process.exit(1);
  }

  if (!paymentRequired.accepts || !paymentRequired.x402Version) {
    console.error("Error: Input doesn't look like x402 payment requirements.");
    console.error("Expected: { x402Version: 2, accepts: [...], ... }");
    process.exit(1);
  }

  // Set up signer
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: base, transport: http(RPC_URL) });

  const evmSigner = {
    address: account.address,
    signTypedData: walletClient.signTypedData.bind(walletClient),
    readContract: publicClient.readContract.bind(publicClient),
    getTransactionCount: publicClient.getTransactionCount.bind(publicClient),
    estimateFeesPerGas: publicClient.estimateFeesPerGas.bind(publicClient),
    signTransaction: walletClient.signTransaction.bind(walletClient),
  };

  const coreClient = new x402Client().register("eip155:*", new ExactEvmScheme(evmSigner));
  const client = new x402HTTPClient(coreClient);

  // Create payment payload
  const payload = await client.createPaymentPayload(paymentRequired);
  const headers = client.encodePaymentSignatureHeader(payload);
  const signature = headers["PAYMENT-SIGNATURE"];

  if (!signature) {
    console.error("Error: Failed to generate payment signature.");
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify({
      paymentSignature: signature,
      payer: account.address,
      network: "eip155:8453",
      asset: "USDC",
    }, null, 2));
  } else {
    process.stdout.write(signature);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
