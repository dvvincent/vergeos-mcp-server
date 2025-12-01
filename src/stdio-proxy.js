#!/usr/bin/env node

/**
 * VergeOS MCP Server - Stdio Proxy
 * 
 * This wraps the HTTP server as a stdio MCP server for local use with Windsurf.
 * It forwards MCP requests to the remote HTTP server.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Remote server URL
const SERVER_URL = process.env.VERGEOS_MCP_URL || "https://your-mcp-server.example.com";

// Fetch helper
async function apiCall(path, options = {}) {
  const fetch = (await import("node-fetch")).default;
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  
  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`);
  }
  
  return response.json();
}

// Create MCP Server
const server = new Server(
  {
    name: "vergeos-mcp-proxy",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Define Tools
const TOOLS = [
  { name: "list_vms", description: "List all virtual machines in VergeOS", inputSchema: { type: "object", properties: { running: { type: "boolean" }, name: { type: "string" } } } },
  { name: "get_vm", description: "Get VM details by ID", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "get_vm_status", description: "Get VM running status", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "power_on_vm", description: "Power on a VM", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "power_off_vm", description: "Power off a VM", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "reset_vm", description: "Reset a VM", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "get_vm_nics", description: "Get VM network interfaces", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "get_vm_drives", description: "Get VM disk drives", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "list_networks", description: "List virtual networks", inputSchema: { type: "object", properties: {} } },
  { name: "get_network", description: "Get network details", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "network_action", description: "Perform network action", inputSchema: { type: "object", properties: { id: { type: "number" }, action: { type: "string", enum: ["poweron", "poweroff", "reset", "apply"] } }, required: ["id", "action"] } },
  { name: "list_tenants", description: "List tenants", inputSchema: { type: "object", properties: {} } },
  { name: "get_tenant", description: "Get tenant details", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "tenant_action", description: "Perform tenant action", inputSchema: { type: "object", properties: { id: { type: "number" }, action: { type: "string", enum: ["poweron", "poweroff", "reset"] } }, required: ["id", "action"] } },
  { name: "list_nodes", description: "List cluster nodes", inputSchema: { type: "object", properties: {} } },
  { name: "get_node_stats", description: "Get node statistics", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "get_cluster_status", description: "Get cluster status", inputSchema: { type: "object", properties: {} } },
  { name: "get_cluster_stats", description: "Get cluster tier stats", inputSchema: { type: "object", properties: {} } },
  { name: "list_volumes", description: "List storage volumes", inputSchema: { type: "object", properties: {} } },
  { name: "get_logs", description: "Get system logs", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "get_alarms", description: "Get active alarms", inputSchema: { type: "object", properties: {} } },
];

// Handle list tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await apiCall(`/tools/${name}`, {
      method: "POST",
      body: JSON.stringify(args || {}),
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result.result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Handle resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      { uri: "vergeos://cluster/status", name: "Cluster Status", mimeType: "application/json" },
      { uri: "vergeos://vms/list", name: "Virtual Machines", mimeType: "application/json" },
      { uri: "vergeos://networks/list", name: "Virtual Networks", mimeType: "application/json" },
      { uri: "vergeos://alarms/active", name: "Active Alarms", mimeType: "application/json" },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  let result;

  switch (uri) {
    case "vergeos://cluster/status":
      result = await apiCall("/cluster/status");
      break;
    case "vergeos://vms/list":
      result = await apiCall("/vms");
      break;
    case "vergeos://networks/list":
      result = await apiCall("/networks");
      break;
    case "vergeos://alarms/active":
      result = await apiCall("/alarms");
      break;
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }

  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
  };
});

// Start
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("VergeOS MCP Proxy connected to:", SERVER_URL);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
