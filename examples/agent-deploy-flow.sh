#!/bin/bash
#
# Full domainagent deploy flow using MCP tools + x402 signer
#
# This script demonstrates the complete agent workflow:
# 1. Search for a domain
# 2. Attempt deploy (get 402 payment requirements)
# 3. Sign payment with x402-signer.js
# 4. Retry deploy with payment signature
# 5. Check status
#
# Prerequisites:
#   npm install -g mcporter
#   npm install viem @x402/core @x402/evm
#   export WALLET_PRIVATE_KEY=0x...
#
# Usage:
#   ./agent-deploy-flow.sh <domain> <path-to-zip>

set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> <path-to-zip>}"
ZIP_PATH="${2:?Usage: $0 <domain> <path-to-zip>}"
OWNER="${WALLET_ADDRESS:?Set WALLET_ADDRESS to your 0x... address}"
EMAIL="${CONTACT_EMAIL:-you@example.com}"
MCP_SERVER="${MCP_SERVER:-node $(dirname $0)/../mcp-server.js}"
SIGNER="node $(dirname $0)/x402-signer.js"

echo "=== domainagent deploy flow ==="
echo "Domain: $DOMAIN"
echo "Owner:  $OWNER"
echo "Email:  $EMAIL"
echo ""

# Step 1: Search
echo "→ Searching for $DOMAIN..."
mcporter call --stdio "$MCP_SERVER" domainagent_search \
  --args "{\"query\":\"${DOMAIN%%.*}\",\"tlds\":[\".${DOMAIN#*.}\"]}" \
  --output json | jq .

# Step 2: Base64 encode the zip
echo ""
echo "→ Encoding zip..."
FILES_B64=$(base64 -i "$ZIP_PATH")

# Step 3: First deploy attempt (will return 402)
echo "→ Attempting deploy (expecting 402)..."
DEPLOY_ARGS=$(jq -n \
  --arg domain "$DOMAIN" \
  --arg owner "$OWNER" \
  --arg email "$EMAIL" \
  --arg files "$FILES_B64" \
  '{domain:$domain, owner:$owner, email:$email, filesBase64:$files}')

RESULT=$(mcporter call --stdio "$MCP_SERVER" domainagent_deploy \
  --args "$DEPLOY_ARGS" --output json 2>&1 || true)

echo "$RESULT" | head -5

# Step 4: If 402, extract payment details and sign
if echo "$RESULT" | jq -e '.paymentRequired' >/dev/null 2>&1; then
  echo ""
  echo "→ Payment required. Signing with x402..."
  
  # Save payment details for signer
  echo "$RESULT" > /tmp/domainagent-402.json
  
  # Sign the payment
  PAYMENT_SIG=$($SIGNER --payment-file /tmp/domainagent-402.json)
  
  echo "→ Payment signed. Retrying deploy..."
  
  # Step 5: Retry with payment signature
  PAID_ARGS=$(echo "$DEPLOY_ARGS" | jq --arg sig "$PAYMENT_SIG" '. + {paymentSignature:$sig}')
  
  mcporter call --stdio "$MCP_SERVER" domainagent_deploy \
    --args "$PAID_ARGS" --output json | jq .
else
  echo "$RESULT" | jq .
fi

# Step 6: Check status
echo ""
echo "→ Checking deploy status..."
mcporter call --stdio "$MCP_SERVER" domainagent_status \
  --args "{\"domain\":\"$DOMAIN\"}" --output json | jq '{domain,status,url,hostedBy,flyAppName}'

echo ""
echo "=== Done ==="
