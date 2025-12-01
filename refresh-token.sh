#!/bin/bash
# Refresh VergeOS API token for MCP Server

set -e

source ~/.vergeos-credentials

TOKEN=$(curl -sk -X POST "https://your-vergeos-host/api/sys/tokens" \
  -u "$VERGEOS_USER:$VERGEOS_PASS" \
  -H "Content-Type: application/json" \
  -d "{\"login\":\"$VERGEOS_USER\",\"password\":\"$VERGEOS_PASS\"}" | jq -r '."$key"')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "Error: Failed to get token"
  exit 1
fi

cat > /home/adminuser/vergeos-mcp-server/.env << EOF
VERGEOS_HOST=your-vergeos-host
VERGEOS_TOKEN=$TOKEN
EOF

echo "Token refreshed successfully!"
echo "Token: ${TOKEN:0:10}..."
