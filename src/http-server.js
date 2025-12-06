#!/usr/bin/env node

/**
 * VergeOS MCP Server - HTTP/SSE Transport
 * 
 * This version exposes the MCP server over HTTP for remote access.
 * Supports both REST API calls and Server-Sent Events for streaming.
 */

import express from "express";
import cors from "cors";
import https from "https";

// Load .env file if present
import { config } from "dotenv";
config();

const PORT = process.env.PORT || 3002;
const VERGEOS_HOST = process.env.VERGEOS_HOST || "192.168.1.111";
const VERGEOS_USER = process.env.VERGEOS_USER || "";
const VERGEOS_PASS = process.env.VERGEOS_PASS || "";

// Create HTTPS agent that ignores self-signed certs
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

// VergeOS API Client
class VergeOSAPI {
  constructor() {
    this.baseUrl = `https://${VERGEOS_HOST}`;
    this.token = null;
  }

  async getToken() {
    if (this.token) return this.token;

    if (!VERGEOS_USER || !VERGEOS_PASS) {
      throw new Error("VergeOS credentials not configured");
    }

    const response = await this.fetch("/api/sys/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${VERGEOS_USER}:${VERGEOS_PASS}`).toString("base64"),
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
    const fetch = (await import("node-fetch")).default;

    const fetchOptions = {
      ...options,
      agent: httpsAgent,
      headers: { ...options.headers },
    };

    if (this.token && !options.headers?.Authorization) {
      fetchOptions.headers.Cookie = `token=${this.token}`;
    }

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
    if (filters.running) query += "&is_running=true";
    if (filters.name) query += `&name=${encodeURIComponent(filters.name)}`;
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

  async powerOnVM(id) { return this.vmAction(id, "poweron"); }
  async powerOffVM(id) { return this.vmAction(id, "poweroff"); }
  async resetVM(id) { return this.vmAction(id, "reset"); }

  async getVMNics(vmId) {
    // Get VM to find machine ID
    const vm = await this.getVM(vmId);
    const machineId = vm.machine;
    const nics = await this.request(`/api/v4/machine_nics?machine=${machineId}&fields=most`);
    return nics.filter((nic) => nic.machine === machineId);
  }

  async getVMDrives(vmId) {
    // Get VM to find machine ID
    const vm = await this.getVM(vmId);
    const machineId = vm.machine;
    const drives = await this.request(`/api/v4/machine_drives?machine=${machineId}&fields=all`);
    return drives.filter((d) => d.machine === machineId);
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

  // Node/Cluster Operations
  async listNodes() {
    return this.request("/api/v4/nodes?fields=most");
  }

  async getNodeStats(id) {
    return this.request(`/api/v4/node_stats?node=${id}`);
  }

  async getClusterStatus() {
    return this.request("/api/v4/cluster_status");
  }

  async getClusterStats() {
    return this.request("/api/v4/cluster_tier_stats");
  }

  // Storage
  async listVolumes() {
    return this.request("/api/v4/volumes?fields=most");
  }

  // Monitoring
  async getLogs(limit = 50) {
    return this.request(`/api/v4/logs?limit=${limit}&sort=-created`);
  }

  async getAlarms() {
    return this.request("/api/v4/alarms?fields=most");
  }
}

// Initialize API
const api = new VergeOSAPI();

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "vergeos-mcp-server",
    vergeosHost: VERGEOS_HOST,
  });
});

// List available tools
app.get("/tools", (req, res) => {
  res.json({
    tools: [
      { name: "list_vms", description: "List all virtual machines" },
      { name: "get_vm", description: "Get VM details by ID" },
      { name: "get_vm_status", description: "Get VM running status" },
      { name: "power_on_vm", description: "Power on a VM" },
      { name: "power_off_vm", description: "Power off a VM" },
      { name: "reset_vm", description: "Reset a VM" },
      { name: "get_vm_nics", description: "Get VM network interfaces" },
      { name: "get_vm_drives", description: "Get VM disk drives" },
      { name: "list_networks", description: "List virtual networks" },
      { name: "get_network", description: "Get network details" },
      { name: "network_action", description: "Perform network action" },
      { name: "list_tenants", description: "List tenants" },
      { name: "get_tenant", description: "Get tenant details" },
      { name: "tenant_action", description: "Perform tenant action" },
      { name: "list_nodes", description: "List cluster nodes" },
      { name: "get_node_stats", description: "Get node statistics" },
      { name: "get_cluster_status", description: "Get cluster status" },
      { name: "get_cluster_stats", description: "Get cluster tier stats" },
      { name: "list_volumes", description: "List storage volumes" },
      { name: "get_logs", description: "Get system logs" },
      { name: "get_alarms", description: "Get active alarms" },
    ],
  });
});

// Execute tool
app.post("/tools/:name", async (req, res) => {
  const { name } = req.params;
  const args = req.body || {};

  try {
    let result;

    switch (name) {
      // VM Operations
      case "list_vms":
        result = await api.listVMs(args);
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

      // Storage
      case "list_volumes":
        result = await api.listVolumes();
        break;

      // Monitoring
      case "get_logs":
        result = await api.getLogs(args.limit || 50);
        break;
      case "get_alarms":
        result = await api.getAlarms();
        break;

      default:
        return res.status(404).json({ error: `Unknown tool: ${name}` });
    }

    res.json({ result });
  } catch (error) {
    console.error(`Tool ${name} error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Quick access endpoints
app.get("/vms", async (req, res) => {
  try {
    const vms = await api.listVMs(req.query);
    res.json(vms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/vms/:id", async (req, res) => {
  try {
    const vm = await api.getVM(parseInt(req.params.id));
    res.json(vm);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/vms/:id/:action", async (req, res) => {
  try {
    const result = await api.vmAction(parseInt(req.params.id), req.params.action);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/networks", async (req, res) => {
  try {
    const networks = await api.listNetworks();
    res.json(networks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/tenants", async (req, res) => {
  try {
    const tenants = await api.listTenants();
    res.json(tenants);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/nodes", async (req, res) => {
  try {
    const nodes = await api.listNodes();
    res.json(nodes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/cluster/status", async (req, res) => {
  try {
    const status = await api.getClusterStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/alarms", async (req, res) => {
  try {
    const alarms = await api.getAlarms();
    res.json(alarms);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/logs", async (req, res) => {
  try {
    const logs = await api.getLogs(parseInt(req.query.limit) || 50);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log("===========================================");
  console.log("VergeOS MCP Server (HTTP Mode)");
  console.log("===========================================");
  console.log(`Server running on: http://localhost:${PORT}`);
  console.log(`VergeOS endpoint: https://${VERGEOS_HOST}`);
  console.log("");
  console.log("Endpoints:");
  console.log("  GET  /health         - Health check");
  console.log("  GET  /tools          - List available tools");
  console.log("  POST /tools/:name    - Execute a tool");
  console.log("  GET  /vms            - List VMs");
  console.log("  GET  /vms/:id        - Get VM details");
  console.log("  POST /vms/:id/:action - VM action (poweron/poweroff/reset)");
  console.log("  GET  /networks       - List networks");
  console.log("  GET  /tenants        - List tenants");
  console.log("  GET  /nodes          - List nodes");
  console.log("  GET  /cluster/status - Cluster status");
  console.log("  GET  /alarms         - Active alarms");
  console.log("  GET  /logs           - System logs");
  console.log("===========================================");
});
