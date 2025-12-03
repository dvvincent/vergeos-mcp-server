# VergeOS MCP Server

A Model Context Protocol (MCP) server for interacting with [VergeOS](https://www.verge.io/) virtualization platform. This enables AI assistants like Claude, Windsurf/Cascade, and other MCP-compatible clients to manage VMs, networks, tenants, and monitor your VergeOS cluster through natural language.

## Architecture Overview

This project provides two deployment options:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DEPLOYMENT OPTIONS                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Option 1: Local (stdio)              Option 2: Remote (HTTP + Local Proxy) │
│  ─────────────────────────            ───────────────────────────────────── │
│                                                                              │
│  ┌──────────┐    stdio    ┌─────────┐     ┌──────────┐   HTTP   ┌─────────┐│
│  │ Windsurf │◄──────────►│  MCP    │     │ Windsurf │◄────────►│  Local  ││
│  │ /Claude  │            │ Server  │     │ /Claude  │  stdio   │  Proxy  ││
│  └──────────┘            └────┬────┘     └──────────┘          └────┬────┘│
│                               │                                      │     │
│                               │ HTTPS                          HTTPS │     │
│                               ▼                                      ▼     │
│                          ┌─────────┐                          ┌──────────┐ │
│                          │VergeOS │                          │ K8s MCP  │ │
│                          │  API   │                          │ Server   │ │
│                          └─────────┘                          └────┬─────┘ │
│                                                                    │       │
│                                                               HTTPS│       │
│                                                                    ▼       │
│                                                              ┌──────────┐  │
│                                                              │ VergeOS  │  │
│                                                              │   API    │  │
│                                                              └──────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### When to Use Each Option

| Option | Use Case |
|--------|----------|
| **Local (stdio)** | AI client runs on the same machine that can reach VergeOS |
| **Remote (HTTP)** | AI client is remote (e.g., laptop) and VergeOS is on a private network |

## Features

### MCP Tools

#### VM Power Control
| Tool | Description |
|------|-------------|
| `list_vms` | List all virtual machines (filter by running/name) |
| `get_vm` | Get detailed VM information by ID |
| `get_vm_status` | Get VM running status and power state |
| `power_on_vm` | Power on a VM |
| `power_off_vm` | Gracefully power off with optional wait and auto-force |
| `force_off_vm` | Force power off (hard shutdown) |
| `reset_vm` | Reset/reboot a VM |

#### VM Configuration
| Tool | Description |
|------|-------------|
| `modify_vm` | Change CPU cores and/or RAM (handles running VMs) |
| `add_drive` | Add a new disk drive to a VM |
| `resize_drive` | Expand an existing disk (increase only) |
| `get_vm_nics` | Get VM network interfaces |
| `get_vm_drives` | Get VM disk drives with sizes |

#### Network Management
| Tool | Description |
|------|-------------|
| `list_networks` | List all virtual networks |
| `get_network` | Get network details |
| `network_action` | Power on/off, reset, apply rules |

#### Tenant Management
| Tool | Description |
|------|-------------|
| `list_tenants` | List all tenants |
| `get_tenant` | Get tenant details |
| `tenant_action` | Power on/off, reset tenants |

#### Cluster & Node Management
| Tool | Description |
|------|-------------|
| `list_nodes` | List cluster nodes |
| `get_node_stats` | Get node statistics |
| `get_cluster_status` | Get cluster health status |
| `get_cluster_stats` | Get storage tier statistics |

#### Storage & Monitoring
| Tool | Description |
|------|-------------|
| `list_volumes` | List storage volumes |
| `get_logs` | Get system logs (filter by level/object type) |
| `get_alarms` | Get active alarms |

#### Snapshot Management
| Tool | Description |
|------|-------------|
| `list_vm_snapshots` | List snapshots for a VM |
| `create_vm_snapshot` | Create a snapshot (with optional expiration and quiesce) |
| `delete_vm_snapshot` | Delete a VM snapshot |
| `restore_vm_snapshot` | Restore a VM from a snapshot |

### Smart Features

- **Graceful shutdown with wait**: `power_off_vm` can wait for VM to shut down and auto-force if timeout expires
- **Running VM handling**: `modify_vm` detects running VMs and can auto-shutdown to apply CPU/RAM changes
- **Log filtering**: Filter logs by level (`error`, `warning`, `audit`) or object type (`vm`, `node`, `vnet`)
- **Snapshot expiration**: `create_vm_snapshot` supports automatic expiration (default 7 days)
- **Quiesced snapshots**: Option to quiesce VM before snapshot (requires guest agent)

### MCP Resources

- `vergeos://cluster/status` - Cluster status overview
- `vergeos://vms/list` - All virtual machines
- `vergeos://networks/list` - All virtual networks
- `vergeos://alarms/active` - Active system alarms

---

## Option 1: Local Installation (stdio)

Use this if your AI client runs on a machine that can directly reach your VergeOS instance.

### Installation

```bash
git clone <repo-url> vergeos-mcp-server
cd vergeos-mcp-server
npm install
```

### Configuration

Create a `.env` file:

```bash
VERGEOS_HOST=your-vergeos-host
VERGEOS_USER=admin
VERGEOS_PASS=your-password
```

Or use an API token (recommended):

```bash
# Get a token
curl -sk -X POST "https://your-vergeos-host/api/sys/tokens" \
  -u "admin:password" \
  -H "Content-Type: application/json" \
  -d '{"login":"admin","password":"password"}' | jq -r '."$key"'

# Set in .env
VERGEOS_HOST=your-vergeos-host
VERGEOS_TOKEN=your-token-here
```

### Claude Desktop Configuration

Add to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vergeos": {
      "command": "node",
      "args": ["/path/to/vergeos-mcp-server/src/index.js"],
      "env": {
        "VERGEOS_HOST": "your-vergeos-host",
        "VERGEOS_USER": "admin",
        "VERGEOS_PASS": "your-password"
      }
    }
  }
}
```

### Windsurf Configuration

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "vergeos": {
      "command": "node",
      "args": ["/path/to/vergeos-mcp-server/src/index.js"],
      "env": {
        "VERGEOS_HOST": "your-vergeos-host",
        "VERGEOS_USER": "admin",
        "VERGEOS_PASS": "your-password"
      }
    }
  }
}
```

---

## Option 2: Remote Installation (Kubernetes + Local Proxy)

Use this if your AI client (e.g., Windsurf on your laptop) cannot directly reach VergeOS, but you have a Kubernetes cluster that can.

### Architecture

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   Windsurf  │─────►│ Local Proxy │─────►│  K8s MCP    │─────►│   VergeOS   │
│  (Laptop)   │stdio │  (Laptop)   │HTTPS │  Server     │HTTPS │    API      │
└─────────────┘      └─────────────┘      └─────────────┘      └─────────────┘
                                                │
                                          ┌─────┴─────┐
                                          │  Traefik  │
                                          │  Ingress  │
                                          └───────────┘
```

### Step 1: Deploy to Kubernetes

```bash
# Clone the repo on your K8s host
cd vergeos-mcp-server

# Edit credentials in deploy.sh or create ~/.vergeos-credentials
cat > ~/.vergeos-credentials << EOF
VERGEOS_USER=admin
VERGEOS_PASS=your-password
EOF

# Deploy
./deploy.sh
```

This creates:
- Namespace: `vergeos-mcp`
- Deployment running the HTTP MCP server
- Service exposing port 3002
- IngressRoute for external access (Traefik)

### Step 2: Configure DNS

Add a DNS record pointing to your Traefik ingress:

```
vergeos-mcp.yourdomain.com → <traefik-ip>
```

### Step 3: Test the Server

```bash
# Health check
curl https://vergeos-mcp.yourdomain.com/health

# List VMs
curl https://vergeos-mcp.yourdomain.com/vms

# MCP protocol test
curl -X POST https://vergeos-mcp.yourdomain.com/message \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Step 4: Install Local Proxy (on your laptop)

Since Windsurf only supports stdio-based MCP servers, you need a local proxy:

```bash
# Create directory
mkdir -p ~/.mcp/vergeos
cd ~/.mcp/vergeos

# Create package.json
cat > package.json << 'EOF'
{
  "name": "vergeos-mcp-proxy",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^0.5.0",
    "node-fetch": "^3.3.2"
  }
}
EOF

# Create index.js
cat > index.js << 'EOF'
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SERVER_URL = process.env.VERGEOS_MCP_URL || "https://vergeos-mcp.yourdomain.com";

async function apiCall(path, options = {}) {
  const fetch = (await import("node-fetch")).default;
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  return response.json();
}

const server = new Server({ name: "vergeos", version: "1.0.0" }, { capabilities: { tools: {} } });

const TOOLS = [
  { name: "list_vms", description: "List all VMs in VergeOS", inputSchema: { type: "object", properties: {} } },
  { name: "get_vm", description: "Get VM details by ID", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "power_on_vm", description: "Power on a VM", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "power_off_vm", description: "Power off a VM", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "reset_vm", description: "Reset a VM", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "list_networks", description: "List virtual networks", inputSchema: { type: "object", properties: {} } },
  { name: "list_tenants", description: "List tenants", inputSchema: { type: "object", properties: {} } },
  { name: "list_nodes", description: "List cluster nodes", inputSchema: { type: "object", properties: {} } },
  { name: "get_cluster_status", description: "Get cluster status", inputSchema: { type: "object", properties: {} } },
  { name: "get_alarms", description: "Get active alarms", inputSchema: { type: "object", properties: {} } },
  { name: "get_logs", description: "Get system logs", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await apiCall(`/tools/${name}`, { method: "POST", body: JSON.stringify(args || {}) });
    return { content: [{ type: "text", text: JSON.stringify(result.result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
EOF

# Install dependencies
npm install
```

### Step 5: Configure Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "vergeos": {
      "command": "node",
      "args": ["/Users/yourusername/.mcp/vergeos/index.js"],
      "env": {
        "VERGEOS_MCP_URL": "https://vergeos-mcp.yourdomain.com"
      }
    }
  }
}
```

Restart Windsurf to load the new MCP server.

---

## REST API Reference

The HTTP server also exposes a REST API for direct access:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/tools` | GET | List available MCP tools |
| `/tools/:name` | POST | Execute an MCP tool |
| `/vms` | GET | List all VMs |
| `/vms/:id` | GET | Get VM details |
| `/vms/:id/:action` | POST | VM action (poweron/poweroff/reset) |
| `/networks` | GET | List networks |
| `/tenants` | GET | List tenants |
| `/nodes` | GET | List nodes |
| `/cluster/status` | GET | Cluster status |
| `/alarms` | GET | Active alarms |
| `/logs` | GET | System logs |

### MCP Protocol Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sse` | GET | Server-Sent Events connection |
| `/message` | POST | MCP JSON-RPC messages |

---

## Example Interactions

Once connected, you can ask your AI assistant:

- "List all VMs in VergeOS"
- "Power off the VM named 'test-vm'"
- "Show me the cluster status"
- "What alarms are active?"
- "List all virtual networks"
- "Get details for VM ID 34"
- "How many nodes are in the cluster?"
- "Show me the last 20 log entries"
- "Create a snapshot of VM 34 called 'before-upgrade'"
- "List all snapshots for the web-server VM"
- "Restore VM 34 from snapshot ID 123"
- "Add 2GB RAM to the database VM"
- "Add a 50GB data disk to VM 34"

---

## VergeOS API Notes

### Authentication

VergeOS uses cookie-based authentication:

1. POST to `/api/sys/tokens` with Basic Auth
2. Response contains token in `$key` field
3. Use token as cookie: `Cookie: token=<value>`

```bash
# Get token
TOKEN=$(curl -sk -X POST "https://vergeos/api/sys/tokens" \
  -u "admin:password" \
  -H "Content-Type: application/json" \
  -d '{"login":"admin","password":"password"}' | jq -r '."$key"')

# Use token
curl -sk "https://vergeos/api/v4/vms" -b "token=$TOKEN"
```

### API Quirks

- VMs with `is_snapshot: true` are templates, not running VMs
- `/machine_nics?machine=<ID>` may return NICs from other machines; always filter by machine ID
- Use `fields=most` for detailed responses, but be aware of large payloads

---

## Security Considerations

- SSL verification is disabled for self-signed certificates (common in homelabs)
- Store credentials in environment variables or Kubernetes secrets
- Use API tokens instead of username/password when possible
- The HTTP server should be behind TLS (handled by Traefik/Ingress)
- Consider network policies to restrict access to the MCP server

---

## Troubleshooting

### Connection Issues

```bash
# Test VergeOS API directly
curl -sk https://your-vergeos-host/api/v4/vms -b "token=YOUR_TOKEN"

# Test MCP server
curl https://vergeos-mcp.yourdomain.com/health
```

### Token Expiration

Tokens may expire. The server automatically fetches new tokens using username/password if configured.

```bash
# Manually refresh token
curl -sk -X POST "https://your-vergeos-host/api/sys/tokens" \
  -u "admin:password" \
  -H "Content-Type: application/json" \
  -d '{"login":"admin","password":"password"}'
```

### Kubernetes Logs

```bash
kubectl logs -n vergeos-mcp deployment/vergeos-mcp
kubectl get pods -n vergeos-mcp
```

### Local Proxy Issues

```bash
# Test proxy directly
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node ~/.mcp/vergeos/index.js
```

---

## File Structure

```
vergeos-mcp-server/
├── src/
│   ├── index.js           # Stdio MCP server (local use)
│   ├── http-server.js     # HTTP server (legacy)
│   ├── mcp-http-server.js # HTTP+MCP server (K8s deployment)
│   └── stdio-proxy.js     # Stdio proxy for remote server
├── local-proxy/
│   ├── package.json       # Local proxy dependencies
│   └── index.js           # Local proxy for Windsurf
├── deploy.sh              # Kubernetes deployment script
├── k8s-deployment.yaml    # Kubernetes manifests
├── package.json
├── .env.example
└── README.md
```

---

## License

MIT
