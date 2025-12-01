#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import https from "https";

// Load .env file if present
import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url).pathname });

// VergeOS Configuration
const VERGEOS_HOST = process.env.VERGEOS_HOST || "192.168.1.111";
const VERGEOS_USER = process.env.VERGEOS_USER || "";
const VERGEOS_PASS = process.env.VERGEOS_PASS || "";
const VERGEOS_TOKEN = process.env.VERGEOS_TOKEN || "";

// Create HTTPS agent that ignores self-signed certs
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

// API Helper
class VergeOSAPI {
  constructor() {
    this.baseUrl = `https://${VERGEOS_HOST}`;
    this.token = VERGEOS_TOKEN;
  }

  async getToken() {
    if (this.token) return this.token;

    if (!VERGEOS_USER || !VERGEOS_PASS) {
      throw new Error(
        "VergeOS credentials not configured. Set VERGEOS_USER and VERGEOS_PASS or VERGEOS_TOKEN"
      );
    }

    const response = await this.fetch("/api/sys/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          Buffer.from(`${VERGEOS_USER}:${VERGEOS_PASS}`).toString("base64"),
      },
      body: JSON.stringify({
        login: VERGEOS_USER,
        password: VERGEOS_PASS,
      }),
    });

    const data = await response.json();
    this.token = data.$key;
    return this.token;
  }

  async fetch(path, options = {}) {
    const url = `${this.baseUrl}${path}`;

    const fetchOptions = {
      ...options,
      agent: httpsAgent,
      headers: {
        ...options.headers,
      },
    };

    // Add token cookie if we have one
    if (this.token && !options.headers?.Authorization) {
      fetchOptions.headers.Cookie = `token=${this.token}`;
    }

    const fetch = (await import("node-fetch")).default;
    return fetch(url, fetchOptions);
  }

  async request(path, options = {}) {
    await this.getToken();
    const response = await this.fetch(path, options);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API Error ${response.status}: ${text}`);
    }

    return response.json();
  }

  // VM Operations
  async listVMs(filters = {}) {
    let query = "?fields=most";
    if (filters.running) {
      query += "&is_running=true";
    }
    if (filters.name) {
      query += `&name=${encodeURIComponent(filters.name)}`;
    }
    // Filter out snapshots/templates by default
    const vms = await this.request(`/api/v4/vms${query}`);
    return vms.filter((vm) => !vm.is_snapshot);
  }

  async getVM(id) {
    return this.request(`/api/v4/vms/${id}?fields=most`);
  }

  async getVMStatus(id) {
    return this.request(`/api/v4/machine_status?machine=${id}`);
  }

  async vmAction(id, action) {
    return this.request("/api/v4/vm_actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vm: id, action }),
    });
  }

  async powerOnVM(id) {
    return this.vmAction(id, "poweron");
  }

  async powerOffVM(id) {
    return this.vmAction(id, "poweroff");
  }

  async resetVM(id) {
    return this.vmAction(id, "reset");
  }

  // Network Operations
  async listNetworks() {
    return this.request("/api/v4/vnets?fields=most");
  }

  async getNetwork(id) {
    return this.request(`/api/v4/vnets/${id}?fields=most`);
  }

  async networkAction(id, action) {
    return this.request("/api/v4/vnet_actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnet: id, action }),
    });
  }

  // Tenant Operations
  async listTenants() {
    return this.request("/api/v4/tenants?fields=most");
  }

  async getTenant(id) {
    return this.request(`/api/v4/tenants/${id}?fields=most`);
  }

  async tenantAction(id, action) {
    return this.request("/api/v4/tenant_actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenant: id, action }),
    });
  }

  // Node Operations
  async listNodes() {
    return this.request("/api/v4/nodes?fields=most");
  }

  async getNodeStats(id) {
    return this.request(`/api/v4/node_stats?node=${id}`);
  }

  // Cluster Operations
  async getClusterStatus() {
    return this.request("/api/v4/cluster_status");
  }

  async getClusterStats() {
    return this.request("/api/v4/cluster_tier_stats");
  }

  // Storage Operations
  async listVolumes() {
    return this.request("/api/v4/volumes?fields=most");
  }

  // Machine NICs
  async getVMNics(machineId) {
    const nics = await this.request(
      `/api/v4/machine_nics?machine=${machineId}&fields=most`
    );
    // Filter to only this machine's NICs (API quirk)
    return nics.filter((nic) => nic.machine === machineId);
  }

  // Machine Drives
  async getVMDrives(machineId) {
    return this.request(`/api/v4/machine_drives?machine=${machineId}&fields=most`);
  }

  // Logs
  async getLogs(limit = 50) {
    return this.request(`/api/v4/logs?limit=${limit}&sort=-created`);
  }

  // Alarms
  async getAlarms() {
    return this.request("/api/v4/alarms?fields=most");
  }
}

// Initialize API
const api = new VergeOSAPI();

// Create MCP Server
const server = new Server(
  {
    name: "vergeos-mcp-server",
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
  // VM Tools
  {
    name: "list_vms",
    description:
      "List all virtual machines in VergeOS. Can filter by running status or name.",
    inputSchema: {
      type: "object",
      properties: {
        running: {
          type: "boolean",
          description: "Filter to only running VMs",
        },
        name: {
          type: "string",
          description: "Filter by VM name (partial match)",
        },
      },
    },
  },
  {
    name: "get_vm",
    description: "Get detailed information about a specific VM by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "VM ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_vm_status",
    description: "Get the current status of a VM (running, stopped, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "VM ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "power_on_vm",
    description: "Power on a virtual machine",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "VM ID to power on",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "power_off_vm",
    description: "Power off a virtual machine (graceful shutdown)",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "VM ID to power off",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "reset_vm",
    description: "Reset/reboot a virtual machine",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "VM ID to reset",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_vm_nics",
    description: "Get network interfaces for a VM",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "VM ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_vm_drives",
    description: "Get disk drives for a VM",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "VM ID",
        },
      },
      required: ["id"],
    },
  },

  // Network Tools
  {
    name: "list_networks",
    description: "List all virtual networks in VergeOS",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_network",
    description: "Get detailed information about a specific network",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Network ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "network_action",
    description:
      "Perform an action on a network (poweron, poweroff, reset, apply)",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Network ID",
        },
        action: {
          type: "string",
          enum: ["poweron", "poweroff", "reset", "apply", "applydns"],
          description: "Action to perform",
        },
      },
      required: ["id", "action"],
    },
  },

  // Tenant Tools
  {
    name: "list_tenants",
    description: "List all tenants in VergeOS",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_tenant",
    description: "Get detailed information about a specific tenant",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Tenant ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "tenant_action",
    description: "Perform an action on a tenant (poweron, poweroff, reset)",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Tenant ID",
        },
        action: {
          type: "string",
          enum: ["poweron", "poweroff", "reset", "isolateon", "isolateoff"],
          description: "Action to perform",
        },
      },
      required: ["id", "action"],
    },
  },

  // Cluster/Node Tools
  {
    name: "list_nodes",
    description: "List all nodes in the VergeOS cluster",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_node_stats",
    description: "Get statistics for a specific node",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "number",
          description: "Node ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_cluster_status",
    description: "Get the overall cluster status",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_cluster_stats",
    description: "Get cluster tier statistics (storage tiers)",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  // Storage Tools
  {
    name: "list_volumes",
    description: "List all storage volumes",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  // Monitoring Tools
  {
    name: "get_logs",
    description: "Get recent system logs",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of log entries to retrieve (default 50)",
        },
      },
    },
  },
  {
    name: "get_alarms",
    description: "Get active system alarms",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      // VM Operations
      case "list_vms":
        result = await api.listVMs(args || {});
        break;
      case "get_vm":
        result = await api.getVM(args.id);
        break;
      case "get_vm_status":
        result = await api.getVMStatus(args.id);
        break;
      case "power_on_vm":
        result = await api.powerOnVM(args.id);
        break;
      case "power_off_vm":
        result = await api.powerOffVM(args.id);
        break;
      case "reset_vm":
        result = await api.resetVM(args.id);
        break;
      case "get_vm_nics":
        result = await api.getVMNics(args.id);
        break;
      case "get_vm_drives":
        result = await api.getVMDrives(args.id);
        break;

      // Network Operations
      case "list_networks":
        result = await api.listNetworks();
        break;
      case "get_network":
        result = await api.getNetwork(args.id);
        break;
      case "network_action":
        result = await api.networkAction(args.id, args.action);
        break;

      // Tenant Operations
      case "list_tenants":
        result = await api.listTenants();
        break;
      case "get_tenant":
        result = await api.getTenant(args.id);
        break;
      case "tenant_action":
        result = await api.tenantAction(args.id, args.action);
        break;

      // Node/Cluster Operations
      case "list_nodes":
        result = await api.listNodes();
        break;
      case "get_node_stats":
        result = await api.getNodeStats(args.id);
        break;
      case "get_cluster_status":
        result = await api.getClusterStatus();
        break;
      case "get_cluster_stats":
        result = await api.getClusterStats();
        break;

      // Storage Operations
      case "list_volumes":
        result = await api.listVolumes();
        break;

      // Monitoring Operations
      case "get_logs":
        result = await api.getLogs(args?.limit || 50);
        break;
      case "get_alarms":
        result = await api.getAlarms();
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Define Resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "vergeos://cluster/status",
        name: "Cluster Status",
        description: "Current VergeOS cluster status and health",
        mimeType: "application/json",
      },
      {
        uri: "vergeos://vms/list",
        name: "Virtual Machines",
        description: "List of all virtual machines",
        mimeType: "application/json",
      },
      {
        uri: "vergeos://networks/list",
        name: "Virtual Networks",
        description: "List of all virtual networks",
        mimeType: "application/json",
      },
      {
        uri: "vergeos://alarms/active",
        name: "Active Alarms",
        description: "Current active system alarms",
        mimeType: "application/json",
      },
    ],
  };
});

// Handle resource reads
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  try {
    let result;

    switch (uri) {
      case "vergeos://cluster/status":
        result = await api.getClusterStatus();
        break;
      case "vergeos://vms/list":
        result = await api.listVMs();
        break;
      case "vergeos://networks/list":
        result = await api.listNetworks();
        break;
      case "vergeos://alarms/active":
        result = await api.getAlarms();
        break;
      default:
        throw new Error(`Unknown resource: ${uri}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to read resource: ${error.message}`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("VergeOS MCP Server running on stdio");
  console.error(`Connecting to: https://${VERGEOS_HOST}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
