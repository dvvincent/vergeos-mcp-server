#!/usr/bin/env node
/**
 * VergeOS MCP Server - Direct Connection Mode
 * Connects directly to VergeOS API without intermediate server
 */

// Disable TLS certificate validation for self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import https from "https";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Configuration from environment
const VERGEOS_HOST = process.env.VERGEOS_HOST;
const VERGEOS_USER = process.env.VERGEOS_USER;
const VERGEOS_PASS = process.env.VERGEOS_PASS;

if (!VERGEOS_HOST || !VERGEOS_USER || !VERGEOS_PASS) {
  console.error("Missing required environment variables: VERGEOS_HOST, VERGEOS_USER, VERGEOS_PASS");
  process.exit(1);
}

const BASE_URL = `https://${VERGEOS_HOST}`;
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Token management
let authToken = null;

async function getToken() {
  if (authToken) return authToken;
  
  const fetch = (await import("node-fetch")).default;
  const response = await fetch(`${BASE_URL}/api/sys/tokens`, {
    method: "POST",
    agent: httpsAgent,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Basic " + Buffer.from(`${VERGEOS_USER}:${VERGEOS_PASS}`).toString("base64"),
    },
    body: JSON.stringify({ login: VERGEOS_USER, password: VERGEOS_PASS }),
  });
  
  if (!response.ok) throw new Error(`Auth failed: ${response.status}`);
  const data = await response.json();
  authToken = data.$key;
  return authToken;
}

async function apiRequest(path, options = {}) {
  const fetch = (await import("node-fetch")).default;
  const token = await getToken();
  
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    agent: httpsAgent,
    headers: {
      "Content-Type": "application/json",
      "Cookie": `token=${token}`,
      ...options.headers,
    },
  });
  
  if (response.status === 401) {
    authToken = null; // Token expired, retry
    return apiRequest(path, options);
  }
  
  if (!response.ok) throw new Error(`API Error: ${response.status} ${response.statusText}`);
  return response.json();
}

// ============ API Methods ============

async function listVMs(options = {}) {
  const { running, name } = options;
  const vms = await apiRequest("/api/v4/vms?fields=most&is_snapshot=eq.false");
  
  let filtered = vms;
  if (running !== undefined) {
    const statuses = await apiRequest("/api/v4/machine_status");
    const runningIds = new Set(statuses.filter(s => s.running).map(s => s.machine));
    filtered = filtered.filter(vm => running ? runningIds.has(vm.machine) : !runningIds.has(vm.machine));
  }
  if (name) filtered = filtered.filter(vm => vm.name?.toLowerCase().includes(name.toLowerCase()));
  
  // Get power states
  const statuses = await apiRequest("/api/v4/machine_status");
  const statusMap = Object.fromEntries(statuses.map(s => [s.machine, s]));
  
  return filtered.map(vm => {
    const status = statusMap[vm.machine] || {};
    return {
      id: vm.$key,
      name: vm.name,
      machine: vm.machine,
      enabled: vm.enabled,
      running: status.running || false,
      status: status.running ? "running" : "stopped",
      cpu_cores: vm.cpu_cores,
      ram: vm.ram,
      os_family: vm.os_family,
      description: vm.description || "",
    };
  });
}

async function getVM(id) {
  const vm = await apiRequest(`/api/v4/vms/${id}?fields=most`);
  const statuses = await apiRequest("/api/v4/machine_status");
  const status = statuses.find(s => s.machine === vm.machine) || {};
  
  return {
    id: vm.$key,
    name: vm.name,
    machine: vm.machine,
    enabled: vm.enabled,
    running: status.running || false,
    status: status.running ? "running" : "stopped",
    cpu_cores: vm.cpu_cores,
    ram: vm.ram,
    os_family: vm.os_family,
    description: vm.description || "",
  };
}

async function getVMStatus(id) {
  const vm = await apiRequest(`/api/v4/vms/${id}?fields=most`);
  const statuses = await apiRequest("/api/v4/machine_status");
  const status = statuses.find(s => s.machine === vm.machine) || {};
  return { id, name: vm.name, running: status.running || false, status: status.running ? "running" : "stopped" };
}

async function vmAction(id, action) {
  return apiRequest("/api/v4/vm_actions", {
    method: "POST",
    body: JSON.stringify({ vm: id, action }),
  });
}

async function powerOnVM(id) { return vmAction(id, "poweron"); }
async function forceOffVM(id) { return vmAction(id, "kill"); }
async function resetVM(id) { return vmAction(id, "reset"); }

async function powerOffVM(id, options = {}) {
  const { wait_timeout = 0, force_after_timeout = false } = options;
  await vmAction(id, "shutdown");
  
  if (wait_timeout > 0) {
    const startTime = Date.now();
    const maxWait = Math.min(wait_timeout, 300) * 1000;
    
    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, 3000));
      const status = await getVMStatus(id);
      if (!status.running) return { success: true, message: "VM shut down gracefully", waited_seconds: Math.round((Date.now() - startTime) / 1000) };
    }
    
    if (force_after_timeout) {
      await forceOffVM(id);
      return { success: true, message: "VM force powered off after timeout", forced: true };
    }
    return { success: false, message: "Shutdown timed out", timeout: true };
  }
  
  return { success: true, message: "Shutdown signal sent" };
}

async function getVMNics(id) {
  const nics = await apiRequest(`/api/v4/machine_nics?machine=${id}&fields=most`);
  return nics.filter(n => n.machine === id).map(n => ({
    id: n.$key, name: n.name, mac: n.mac, network: n.vnet_name, ip: n.ip_address,
  }));
}

async function getVMDrives(id) {
  const drives = await apiRequest(`/api/v4/machine_drives?machine=${id}&fields=most`);
  return drives.filter(d => d.machine === id).map(d => ({
    id: d.$key, name: d.name, size_bytes: d.disksize, size_gb: Math.round(d.disksize / 1073741824 * 10) / 10,
    interface: d.interface_type, media: d.media_type,
  }));
}

async function resizeDrive(drive_id, new_size_gb) {
  const drive = await apiRequest(`/api/v4/machine_drives/${drive_id}`);
  const new_size_bytes = new_size_gb * 1073741824;
  if (new_size_bytes <= drive.disksize) throw new Error("New size must be larger than current size");
  
  await apiRequest(`/api/v4/machine_drives/${drive_id}`, {
    method: "PUT",
    body: JSON.stringify({ disksize: new_size_bytes }),
  });
  return { success: true, drive_id, old_size_gb: Math.round(drive.disksize / 1073741824 * 10) / 10, new_size_gb };
}

async function addDrive(machine_id, options) {
  const { name, size_gb, interface_type = "virtio-scsi", description = "" } = options;
  const result = await apiRequest("/api/v4/machine_drives", {
    method: "POST",
    body: JSON.stringify({
      machine: machine_id, name, disksize: size_gb * 1073741824,
      interface_type, media_type: "disk", description,
    }),
  });
  return { success: true, drive_id: result.$key, name, size_gb };
}

async function modifyVM(id, options) {
  const { cpu_cores, ram_mb, shutdown_if_running, wait_timeout = 60, force_after_timeout = true } = options;
  if (!cpu_cores && !ram_mb) throw new Error("Specify cpu_cores and/or ram_mb");
  
  const status = await getVMStatus(id);
  if (status.running) {
    if (!shutdown_if_running) throw new Error("VM is running. Set shutdown_if_running=true to shut down first.");
    await powerOffVM(id, { wait_timeout, force_after_timeout });
  }
  
  const vm = await apiRequest(`/api/v4/vms/${id}`);
  const updates = {};
  if (cpu_cores) updates.cpu_cores = cpu_cores;
  if (ram_mb) updates.ram = ram_mb;
  
  await apiRequest(`/api/v4/vms/${id}`, { method: "PUT", body: JSON.stringify(updates) });
  return { success: true, vm_id: id, previous_cpu: vm.cpu_cores, previous_ram_mb: vm.ram, new_cpu: cpu_cores || vm.cpu_cores, new_ram_mb: ram_mb || vm.ram };
}

async function listNetworks(options = {}) {
  const { type, name, enabled, limit = 100, offset = 0 } = options;
  const networks = await apiRequest("/api/v4/vnets?fields=most");
  
  let filtered = networks;
  if (type) filtered = filtered.filter(n => n.type === type);
  if (name) filtered = filtered.filter(n => n.name?.toLowerCase().includes(name.toLowerCase()));
  if (enabled !== undefined) filtered = filtered.filter(n => n.enabled === enabled);
  
  return filtered.slice(offset, offset + limit).map(n => ({
    id: n.$key, name: n.name, type: n.type, network: n.network, enabled: n.enabled, description: n.description || null,
  }));
}

async function getNetwork(id) { return apiRequest(`/api/v4/vnets/${id}?fields=most`); }

async function networkAction(id, action) {
  return apiRequest("/api/v4/vnet_actions", { method: "POST", body: JSON.stringify({ vnet: id, action }) });
}

async function listTenants() { return apiRequest("/api/v4/tenants?fields=most"); }
async function getTenant(id) { return apiRequest(`/api/v4/tenants/${id}?fields=most`); }
async function tenantAction(id, action) {
  return apiRequest("/api/v4/tenant_actions", { method: "POST", body: JSON.stringify({ tenant: id, action }) });
}

async function listNodes() { return apiRequest("/api/v4/nodes?fields=most"); }
async function getNodeStats(id) { return apiRequest(`/api/v4/node_stats?node=${id}`); }
async function getClusterStatus() { return apiRequest("/api/v4/cluster_status"); }
async function getClusterStats() { return apiRequest("/api/v4/cluster_tier_stats"); }
async function listVolumes() { return apiRequest("/api/v4/volumes?fields=most"); }
async function getAlarms() { return apiRequest("/api/v4/alarms?fields=most"); }

async function getLogs(options = {}) {
  const { limit = 50, level, object_type } = options;
  const fetchLimit = (level || object_type) ? Math.min(limit * 5, 500) : limit;
  const logs = await apiRequest(`/api/v4/logs?fields=all&limit=${fetchLimit}&sort=-$key`);
  
  let filtered = logs;
  if (level) filtered = filtered.filter(l => l.level === level);
  if (object_type) filtered = filtered.filter(l => l.object_type === object_type);
  
  return filtered.slice(0, limit).map(l => ({
    id: l.$key, timestamp: l.dbtime, level: l.level, text: l.text, user: l.user, object_type: l.object_type, object_name: l.object_name,
  }));
}

// ============ Tool Definitions ============

const TOOLS = [
  { name: "list_vms", description: "List all VMs in VergeOS", inputSchema: { type: "object", properties: { running: { type: "boolean", description: "Filter to running VMs only" }, name: { type: "string", description: "Filter by name" } } } },
  { name: "get_vm", description: "Get VM details by ID", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "get_vm_status", description: "Get VM power status", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "power_on_vm", description: "Power on a VM", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "power_off_vm", description: "Power off a VM (graceful). Use wait_timeout and force_after_timeout for reliable shutdown.", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" }, wait_timeout: { type: "number", description: "Seconds to wait (max 300)" }, force_after_timeout: { type: "boolean", description: "Force if timeout" } }, required: ["id"] } },
  { name: "force_off_vm", description: "Force power off a VM (hard shutdown)", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "reset_vm", description: "Reset/reboot a VM", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "get_vm_nics", description: "Get VM network interfaces", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "get_vm_drives", description: "Get VM disk drives", inputSchema: { type: "object", properties: { id: { type: "number", description: "Machine ID" } }, required: ["id"] } },
  { name: "resize_drive", description: "Resize a VM disk (increase only)", inputSchema: { type: "object", properties: { drive_id: { type: "number" }, new_size_gb: { type: "number" } }, required: ["drive_id", "new_size_gb"] } },
  { name: "add_drive", description: "Add a new disk drive to a VM", inputSchema: { type: "object", properties: { machine_id: { type: "number" }, name: { type: "string" }, size_gb: { type: "number" }, interface_type: { type: "string", enum: ["virtio-scsi", "virtio", "ide", "ahci"] } }, required: ["machine_id", "name", "size_gb"] } },
  { name: "modify_vm", description: "Modify VM CPU/RAM. Set shutdown_if_running=true if VM is running.", inputSchema: { type: "object", properties: { id: { type: "number" }, cpu_cores: { type: "number" }, ram_mb: { type: "number" }, shutdown_if_running: { type: "boolean" } }, required: ["id"] } },
  { name: "list_networks", description: "List virtual networks (summary)", inputSchema: { type: "object", properties: { type: { type: "string" }, name: { type: "string" }, enabled: { type: "boolean" }, limit: { type: "number" }, offset: { type: "number" } } } },
  { name: "get_network", description: "Get network details", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "network_action", description: "Network action (poweron/poweroff/reset/apply)", inputSchema: { type: "object", properties: { id: { type: "number" }, action: { type: "string", enum: ["poweron", "poweroff", "reset", "apply"] } }, required: ["id", "action"] } },
  { name: "list_tenants", description: "List all tenants", inputSchema: { type: "object", properties: {} } },
  { name: "get_tenant", description: "Get tenant details", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "tenant_action", description: "Tenant action", inputSchema: { type: "object", properties: { id: { type: "number" }, action: { type: "string", enum: ["poweron", "poweroff", "reset"] } }, required: ["id", "action"] } },
  { name: "list_nodes", description: "List cluster nodes", inputSchema: { type: "object", properties: {} } },
  { name: "get_node_stats", description: "Get node statistics", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "get_cluster_status", description: "Get cluster status", inputSchema: { type: "object", properties: {} } },
  { name: "get_cluster_stats", description: "Get cluster tier stats", inputSchema: { type: "object", properties: {} } },
  { name: "list_volumes", description: "List storage volumes", inputSchema: { type: "object", properties: {} } },
  { name: "get_logs", description: "Get system logs", inputSchema: { type: "object", properties: { limit: { type: "number" }, level: { type: "string", enum: ["audit", "message", "warning", "error", "critical"] }, object_type: { type: "string", enum: ["vm", "vnet", "tenant", "node", "cluster", "user", "system", "task"] } } } },
  { name: "get_alarms", description: "Get active alarms", inputSchema: { type: "object", properties: {} } },
];

// ============ Tool Executor ============

async function executeTool(name, args) {
  switch (name) {
    case "list_vms": return listVMs(args);
    case "get_vm": return getVM(args.id);
    case "get_vm_status": return getVMStatus(args.id);
    case "power_on_vm": return powerOnVM(args.id);
    case "power_off_vm": return powerOffVM(args.id, args);
    case "force_off_vm": return forceOffVM(args.id);
    case "reset_vm": return resetVM(args.id);
    case "get_vm_nics": return getVMNics(args.id);
    case "get_vm_drives": return getVMDrives(args.id);
    case "resize_drive": return resizeDrive(args.drive_id, args.new_size_gb);
    case "add_drive": return addDrive(args.machine_id, args);
    case "modify_vm": return modifyVM(args.id, args);
    case "list_networks": return listNetworks(args);
    case "get_network": return getNetwork(args.id);
    case "network_action": return networkAction(args.id, args.action);
    case "list_tenants": return listTenants();
    case "get_tenant": return getTenant(args.id);
    case "tenant_action": return tenantAction(args.id, args.action);
    case "list_nodes": return listNodes();
    case "get_node_stats": return getNodeStats(args.id);
    case "get_cluster_status": return getClusterStatus();
    case "get_cluster_stats": return getClusterStats();
    case "list_volumes": return listVolumes();
    case "get_logs": return getLogs(args);
    case "get_alarms": return getAlarms();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ============ MCP Server ============

const server = new Server(
  { name: "vergeos-direct", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await executeTool(name, args || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
