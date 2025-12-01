#!/usr/bin/env node

// Disable TLS certificate validation for self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import https from "https";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SERVER_URL = process.env.VERGEOS_MCP_URL || "https://your-mcp-server.example.com";

// HTTPS agent that ignores self-signed certificates
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function apiCall(path, options = {}) {
  const fetch = (await import("node-fetch")).default;
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    agent: SERVER_URL.startsWith('https') ? httpsAgent : undefined,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  return response.json();
}

const server = new Server(
  { name: "vergeos", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  { name: "list_vms", description: "List all VMs in VergeOS", inputSchema: { type: "object", properties: { running: { type: "boolean", description: "Filter to running VMs only" }, name: { type: "string", description: "Filter by name" } } } },
  { name: "get_vm", description: "Get VM details by ID", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "power_on_vm", description: "Power on a VM", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "power_off_vm", description: "Power off a VM (graceful shutdown). Use wait_timeout to wait for completion, and force_after_timeout to auto-force if graceful shutdown fails.", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" }, wait_timeout: { type: "number", description: "Seconds to wait for graceful shutdown (0 = don't wait, max 300). Recommended: 60-120." }, force_after_timeout: { type: "boolean", description: "If true, force power off after wait_timeout expires. Recommended: true." } }, required: ["id"] } },
  { name: "force_off_vm", description: "Force power off a VM (hard shutdown - use when graceful shutdown fails)", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "reset_vm", description: "Reset/reboot a VM", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "get_vm_nics", description: "Get VM network interfaces", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "get_vm_drives", description: "Get VM disk drives (use machine ID, not VM ID)", inputSchema: { type: "object", properties: { id: { type: "number", description: "Machine ID (from VM's 'machine' field)" } }, required: ["id"] } },
  { name: "resize_drive", description: "Resize a VM disk drive (increase only). Get drive IDs from get_vm_drives first.", inputSchema: { type: "object", properties: { drive_id: { type: "number", description: "Drive ID (from get_vm_drives)" }, new_size_gb: { type: "number", description: "New size in GB (must be larger than current size)" } }, required: ["drive_id", "new_size_gb"] } },
  { name: "add_drive", description: "Add a new disk drive to a VM. Use machine ID (from VM's 'machine' field), not VM ID.", inputSchema: { type: "object", properties: { machine_id: { type: "number", description: "Machine ID (from VM's 'machine' field)" }, name: { type: "string", description: "Drive name (e.g., 'data-disk')" }, size_gb: { type: "number", description: "Size in GB" }, interface_type: { type: "string", enum: ["virtio-scsi", "virtio", "ide", "ahci"], description: "Interface type (default: virtio-scsi)" }, description: { type: "string", description: "Optional description" } }, required: ["machine_id", "name", "size_gb"] } },
  { name: "modify_vm", description: "Modify VM CPU cores and/or RAM. If VM is running, set shutdown_if_running=true to auto-shutdown, apply changes, then you can restart.", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" }, cpu_cores: { type: "number", description: "New number of CPU cores" }, ram_mb: { type: "number", description: "New RAM in MB (e.g., 4096 for 4GB)" }, shutdown_if_running: { type: "boolean", description: "If true and VM is running, shut it down first to apply changes" }, wait_timeout: { type: "number", description: "Seconds to wait for shutdown (default: 60)" }, force_after_timeout: { type: "boolean", description: "Force shutdown if graceful fails (default: true)" } }, required: ["id"] } },
  { name: "list_networks", description: "List virtual networks (summary view). Use get_network for full details.", inputSchema: { type: "object", properties: { type: { type: "string", description: "Filter by network type (e.g., 'internal', 'external', 'core', 'dmz')" }, name: { type: "string", description: "Filter by name (partial match)" }, enabled: { type: "boolean", description: "Filter by enabled status" }, limit: { type: "number", description: "Max results (default 100)" }, offset: { type: "number", description: "Skip first N results (for pagination)" } } } },
  { name: "get_network", description: "Get network details", inputSchema: { type: "object", properties: { id: { type: "number", description: "Network ID" } }, required: ["id"] } },
  { name: "network_action", description: "Perform network action (poweron/poweroff/reset/apply)", inputSchema: { type: "object", properties: { id: { type: "number" }, action: { type: "string", enum: ["poweron", "poweroff", "reset", "apply"] } }, required: ["id", "action"] } },
  { name: "list_tenants", description: "List all tenants", inputSchema: { type: "object", properties: {} } },
  { name: "get_tenant", description: "Get tenant details", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "tenant_action", description: "Perform tenant action", inputSchema: { type: "object", properties: { id: { type: "number" }, action: { type: "string", enum: ["poweron", "poweroff", "reset"] } }, required: ["id", "action"] } },
  { name: "list_nodes", description: "List cluster nodes", inputSchema: { type: "object", properties: {} } },
  { name: "get_node_stats", description: "Get node statistics", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "get_cluster_status", description: "Get VergeOS cluster status", inputSchema: { type: "object", properties: {} } },
  { name: "get_cluster_stats", description: "Get cluster storage tier stats", inputSchema: { type: "object", properties: {} } },
  { name: "list_volumes", description: "List storage volumes", inputSchema: { type: "object", properties: {} } },
  { name: "get_logs", description: "Get system logs with optional filtering", inputSchema: { type: "object", properties: { limit: { type: "number", description: "Number of logs (default 50)" }, level: { type: "string", enum: ["audit", "message", "warning", "error", "critical", "summary", "debug"], description: "Filter by log level" }, object_type: { type: "string", enum: ["vm", "vnet", "tenant", "node", "cluster", "user", "system", "task"], description: "Filter by object type" } } } },
  { name: "get_alarms", description: "Get active system alarms", inputSchema: { type: "object", properties: {} } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await apiCall(`/tools/${name}`, {
      method: "POST",
      body: JSON.stringify(args || {}),
    });
    return { content: [{ type: "text", text: JSON.stringify(result.result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
