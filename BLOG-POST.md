# Building an MCP Server for VergeOS: AI-Powered Infrastructure Management

*How I built a Model Context Protocol server to manage my VergeOS virtualization cluster using natural language through AI assistants like Claude and Windsurf.*

---

## The Problem: Managing Infrastructure with Natural Language

I run a homelab with [VergeOS](https://www.verge.io/), a powerful hyperconverged infrastructure platform. It's great for managing VMs, networks, and storage—but like most infrastructure tools, it requires either the web UI or direct API calls.

What if I could just ask my AI assistant to "list all running VMs", "power off the test server", or even "add 4GB of RAM to that VM"?

Enter the **Model Context Protocol (MCP)**—Anthropic's open standard for connecting AI assistants to external tools and data sources.

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io/) is a standardized way for AI applications to interact with external systems. Think of it as a universal adapter that lets AI assistants like Claude, Windsurf, and others access your tools, APIs, and data.

MCP servers expose:
- **Tools**: Actions the AI can perform (e.g., `power_on_vm`, `modify_vm`, `resize_drive`)
- **Resources**: Data the AI can read (e.g., cluster status, VM lists)
- **Prompts**: Pre-defined conversation starters

## The Architecture

Here's my setup:
- **VergeOS cluster** running on my local network (your-vergeos-host)
- **Windsurf IDE** on my MacBook
- **Direct network access** from my Mac to VergeOS

### Simple and Direct

Since my Mac can reach VergeOS directly, the architecture is straightforward:

```
┌─────────────┐  stdio   ┌─────────────┐  HTTPS   ┌─────────────┐
│  Windsurf   │◄────────►│  MCP Server │◄────────►│   VergeOS   │
│  (MacBook)  │          │  (MacBook)  │          │ your-vergeos-host│
└─────────────┘          └─────────────┘          └─────────────┘
```

The MCP server runs locally on my Mac, communicates with Windsurf via stdio (standard input/output), and makes HTTPS calls directly to the VergeOS API.

### Alternative: Remote Access via Kubernetes

If your AI client *can't* reach VergeOS directly (e.g., you're on a different network), you can deploy the MCP server to Kubernetes and use a local proxy:

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  Windsurf   │─────►│ Local Proxy │─────►│  K8s MCP    │─────►│   VergeOS   │
│  (Laptop)   │stdio │  (Laptop)   │HTTPS │  Server     │HTTPS │    API      │
└─────────────┘      └─────────────┘      └─────────────┘      └─────────────┘
```

I've included both options in the project, but for most homelab setups where your machine can reach VergeOS, the direct approach is simpler.

## Building the MCP Server

### The VergeOS API

VergeOS has a comprehensive REST API (Swagger 2.0). Key endpoints I needed:

| Endpoint | Purpose |
|----------|---------|
| `/api/v4/vms` | List/manage virtual machines |
| `/api/v4/machine_drives` | VM disk management |
| `/api/v4/machine_status` | Real-time VM power state |
| `/api/v4/vnets` | Virtual networks |
| `/api/v4/tenants` | Multi-tenant management |
| `/api/v4/nodes` | Cluster nodes |
| `/api/v4/cluster_status` | Cluster health |
| `/api/v4/vm_actions` | Power operations (poweron, poweroff, kill, reset) |

Authentication uses cookie-based tokens:

```bash
# Get a token
TOKEN=$(curl -sk -X POST "https://vergeos/api/sys/tokens" \
  -u "admin:password" \
  -H "Content-Type: application/json" \
  -d '{"login":"admin","password":"password"}' | jq -r '."$key"')

# Use it
curl -sk "https://vergeos/api/v4/vms" -b "token=$TOKEN"
```

### The MCP Server (Node.js)

I used the official `@modelcontextprotocol/sdk` to build the server:

```javascript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  { name: "vergeos", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Define tools
const TOOLS = [
  { 
    name: "list_vms", 
    description: "List all VMs in VergeOS",
    inputSchema: { type: "object", properties: {} }
  },
  { 
    name: "power_on_vm", 
    description: "Power on a VM",
    inputSchema: { 
      type: "object", 
      properties: { id: { type: "number" } },
      required: ["id"]
    }
  },
  // ... more tools
];

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  switch (name) {
    case "list_vms":
      const vms = await vergeosApi.listVMs();
      return { content: [{ type: "text", text: JSON.stringify(vms, null, 2) }] };
    case "power_on_vm":
      await vergeosApi.powerOnVM(args.id);
      return { content: [{ type: "text", text: `VM ${args.id} powered on` }] };
    // ... more handlers
  }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Windsurf Configuration

Configure Windsurf to use the MCP server:

```json
{
  "mcpServers": {
    "vergeos": {
      "command": "node",
      "args": ["/Users/dvincent/.mcp/vergeos/index.js"],
      "env": {
        "VERGEOS_HOST": "your-vergeos-host",
        "VERGEOS_USER": "admin",
        "VERGEOS_PASS": "your-password"
      }
    }
  }
}
```

## The Result

Now I can manage my entire VergeOS infrastructure through natural language:

**Me:** "List all running VMs"

**Windsurf:** 
```
Here are the running VMs in your VergeOS cluster:

| Name | Status | CPU | RAM |
|------|--------|-----|-----|
| vergeos-host1 | running | 8 cores | 16 GB |
| rke2-node1 | running | 14 cores | 32 GB |
| rke2-node2 | running | 8 cores | 16 GB |
| nfs-for-kubernetes | running | 4 cores | 8 GB |
```

**Me:** "Power off the test-vm and wait for it to shut down"

**Windsurf:** "VM 'test-vm' shut down gracefully in 23 seconds."

**Me:** "Add 2 more CPU cores and 4GB RAM to test-vm"

**Windsurf:** "VM 'test-vm' is currently stopped. Modified successfully: CPU 2→4 cores, RAM 2048→6144 MB. Use power_on_vm to start it with the new settings."

**Me:** "Add a 100GB data disk to test-vm"

**Windsurf:** "Drive 'data-disk' (100 GB) added to test-vm. The VM may need to be restarted to detect the new drive."

**Me:** "What alarms are active?"

**Windsurf:** "No active alarms in your VergeOS cluster. Everything looks healthy! ✅"

## Available Tools

The MCP server exposes 25 tools for comprehensive infrastructure management:

### VM Power Control
| Tool | Description |
|------|-------------|
| `power_on_vm` | Start a VM |
| `power_off_vm` | Graceful shutdown with optional wait and auto-force |
| `force_off_vm` | Hard power off (kill) |
| `reset_vm` | Reboot a VM |

The `power_off_vm` tool is smart—it can wait for the VM to shut down and automatically force power off if the graceful shutdown times out:

```javascript
power_off_vm({ id: 40, wait_timeout: 60, force_after_timeout: true })
// Waits up to 60s for graceful shutdown, then forces if needed
```

### VM Configuration
| Tool | Description |
|------|-------------|
| `modify_vm` | Change CPU cores and/or RAM (auto-shutdown if running) |
| `add_drive` | Add a new disk to a VM |
| `resize_drive` | Expand an existing disk |
| `get_vm_drives` | List VM disks with sizes |
| `get_vm_nics` | List VM network interfaces |

The `modify_vm` tool handles running VMs gracefully:

```javascript
modify_vm({ id: 40, cpu_cores: 8, ram_mb: 16384, shutdown_if_running: true })
// If VM is running: shuts down → applies changes → tells you to restart
// If VM is stopped: applies changes immediately
```

### Infrastructure
| Tool | Description |
|------|-------------|
| `list_vms` | List VMs with power state (filter by running/name) |
| `get_vm` | Detailed VM info with human-readable power state |
| `get_vm_status` | Quick power state check |
| `list_networks` | Virtual networks |
| `network_action` | Power on/off/reset networks |
| `list_tenants` | Multi-tenant management |
| `list_nodes` | Cluster nodes |
| `get_cluster_status` | Cluster health |
| `get_alarms` | Active alerts |
| `get_logs` | System logs with filtering |

The `get_logs` tool supports filtering by level and object type:

```javascript
get_logs({ limit: 20, level: "error" })
// Returns only error-level logs

get_logs({ limit: 50, object_type: "vm" })
// Returns only VM-related logs (power changes, edits, etc.)
```

Available log levels: `audit`, `message`, `warning`, `error`, `critical`, `summary`, `debug`
Available object types: `vm`, `vnet`, `tenant`, `node`, `cluster`, `user`, `system`, `task`

## Lessons Learned

### 1. Keep Responses Small

My first version returned the full VM objects from the API—including all metadata, recipe configurations, and nested objects. This resulted in 100KB+ responses that got truncated.

**Fix:** Map responses to only essential fields:

```javascript
return vms.map(vm => ({
  id: vm.$key,
  name: vm.name,
  running: status.running,
  status: status.status,  // "running", "stopped", etc.
  cpu_cores: vm.cpu_cores,
  ram: vm.ram,
}));
```

### 2. Human-Readable Status

The VergeOS API returns numeric status codes like `console_status: 40`. These mean nothing to an AI (or a human). I added a separate call to `/machine_status` to get readable states like "running" or "stopped".

### 3. Smart Error Messages

Instead of cryptic API errors, the tools return actionable hints:

```json
{
  "success": false,
  "error": "VM 'test-vm' is currently running. CPU/RAM changes require the VM to be powered off.",
  "hint": "Set shutdown_if_running=true to automatically shut down the VM, apply changes, and restart it"
}
```

### 4. VergeOS API Quirks

- **Snapshots are VMs**: VMs with `is_snapshot: true` are templates, not running machines. Always filter them out.
- **NIC filtering is broken**: `/machine_nics?machine=<ID>` returns NICs from other machines too. Always filter by machine ID in your code.
- **Token in cookie**: Despite the Swagger spec mentioning headers, tokens must be sent as cookies.
- **Power state needs `/machine_status`**: The `/vms` endpoint doesn't reliably show if a VM is running.

### 5. Direct is Best (When Possible)

Initially, I built a complex two-tier architecture with a Kubernetes-hosted HTTP server and a local proxy. But then I realized my Mac could reach VergeOS directly—so I simplified to a single local MCP server.

**Lesson:** Start simple. Only add complexity (proxies, K8s deployments) when your network topology requires it.

### 6. The Proxy Pattern (When You Need It)

If your AI client *can't* reach your infrastructure directly, the proxy pattern works great:
- Deploy an HTTP MCP server to Kubernetes (or any reachable host)
- Run a lightweight local proxy that forwards stdio ↔ HTTP
- Centralizes credentials on the server side

I've included both options in the project for flexibility.

## What's Next?

- **VM Creation**: Add tools to create VMs from templates
- **Snapshot Management**: Create/restore snapshots through natural language  
- **NIC Management**: Add/remove/modify network interfaces
- **Monitoring Dashboard**: Build a web UI on top of the same API
- **Multi-Cluster**: Support multiple VergeOS instances

## Quick Start

Want to try it yourself? Here's the 5-minute setup:

```bash
# 1. Create the directory
mkdir -p ~/.mcp/vergeos && cd ~/.mcp/vergeos

# 2. Initialize and install dependencies
cat > package.json << 'EOF'
{
  "name": "vergeos-mcp",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^0.5.0",
    "node-fetch": "^3.3.2"
  }
}
EOF
npm install

# 3. Download the MCP server
curl -o index.js https://raw.githubusercontent.com/YOUR_REPO/vergeos-mcp-server/main/local-proxy/index.js

# 4. Add to Windsurf config (~/.codeium/windsurf/mcp_config.json)
```

```json
{
  "mcpServers": {
    "vergeos": {
      "command": "node",
      "args": ["~/.mcp/vergeos/index.js"],
      "env": {
        "VERGEOS_HOST": "your-vergeos-ip",
        "VERGEOS_USER": "admin",
        "VERGEOS_PASS": "your-password"
      }
    }
  }
}
```

Restart Windsurf and start chatting with your infrastructure!

## The Full Project

The complete source code includes:
- **25 MCP tools** for comprehensive VM and infrastructure management
- **Smart power control** with wait timeouts and auto-force
- **VM modification** (CPU, RAM, disks) with running VM handling
- **Log retrieval** with level and object type filtering
- **HTTP server** for Kubernetes deployment
- **Local proxy** for remote access scenarios
- **Kubernetes manifests** and deployment scripts
- **Comprehensive documentation**

Available at: [GitHub repo link]

---

If you're running VergeOS (or any infrastructure with a REST API), building an MCP server is a great way to add AI-powered management. The MCP SDK makes it straightforward—I went from zero to managing VMs with natural language in an afternoon.

*Have questions or built your own MCP server? I'd love to hear about it!*

## Resources

- [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [VergeOS](https://www.verge.io/)
- [Windsurf IDE](https://codeium.com/windsurf)
- [Anthropic's MCP Announcement](https://www.anthropic.com/news/model-context-protocol)
