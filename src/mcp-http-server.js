#!/usr/bin/env node

/**
 * VergeOS MCP Server - HTTP+SSE Transport
 * 
 * This implements the MCP HTTP+SSE transport protocol for remote access.
 * Compatible with clients that support the streamable HTTP MCP transport.
 */

import express from "express";
import cors from "cors";
import https from "https";
import { randomUUID } from "crypto";

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
    // Get VMs and their runtime status
    const [vms, statuses] = await Promise.all([
      this.request("/api/v4/vms?fields=most"),
      this.request("/api/v4/machine_status")
    ]);
    
    // Create status lookup by machine ID
    const statusMap = new Map(statuses.map(s => [s.machine, s]));
    
    // Filter and map VMs
    let result = vms
      .filter((vm) => !vm.is_snapshot)
      .map((vm) => {
        const status = statusMap.get(vm.machine) || {};
        return {
          id: vm.$key,
          name: vm.name,
          machine: vm.machine,
          enabled: vm.enabled,
          running: status.running || false,
          status: status.status || "unknown",
          cpu_cores: vm.cpu_cores,
          ram: vm.ram,
          os_family: vm.os_family,
          description: vm.description || "",
        };
      });
    
    // Apply filters
    if (filters.running === true) {
      result = result.filter(vm => vm.running === true);
    } else if (filters.running === false) {
      result = result.filter(vm => vm.running === false);
    }
    if (filters.name) {
      const nameLower = filters.name.toLowerCase();
      result = result.filter(vm => vm.name.toLowerCase().includes(nameLower));
    }
    
    return result;
  }

  async getVM(id) {
    // Get VM details and runtime status
    const [vm, statuses] = await Promise.all([
      this.request(`/api/v4/vms/${id}?fields=most`),
      this.request(`/api/v4/machine_status`)
    ]);
    const status = statuses.find(s => s.machine === vm.machine) || {};
    
    // Add human-readable power state
    return {
      ...vm,
      power_state: status.status || "unknown",
      running: status.running || false,
      status_info: status.status_info || "",
      migratable: status.migratable || false,
    };
  }
  
  async getVMStatus(id) {
    // Get VM to find machine ID, then get status
    const vm = await this.request(`/api/v4/vms/${id}?fields=most`);
    const statuses = await this.request("/api/v4/machine_status");
    const status = statuses.find(s => s.machine === vm.machine);
    
    if (!status) {
      return { vm_id: id, name: vm.name, power_state: "unknown", running: false };
    }
    
    return {
      vm_id: id,
      name: vm.name,
      machine: vm.machine,
      running: status.running,
      power_state: status.status,
      status_info: status.status_info || "",
      migratable: status.migratable,
    };
  }
  async vmAction(id, action) {
    return this.request("/api/v4/vm_actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vm: id, action }),
    });
  }
  async powerOnVM(id) {
    const status = await this.getVMStatus(id);
    if (status.running) {
      return { success: false, error: `VM '${status.name}' is already running`, current_state: status.power_state };
    }
    await this.vmAction(id, "poweron");
    return { success: true, message: `Power on command sent to VM '${status.name}'`, previous_state: status.power_state };
  }
  
  async powerOffVM(id, options = {}) {
    const { wait_timeout = 0, force_after_timeout = false } = options;
    const status = await this.getVMStatus(id);
    
    if (!status.running) {
      return { success: true, message: `VM '${status.name}' is already stopped`, current_state: status.power_state, was_running: false };
    }
    
    // Send graceful shutdown
    await this.vmAction(id, "poweroff");
    
    // If no wait requested, return immediately
    if (wait_timeout <= 0) {
      return { 
        success: true, 
        message: `Graceful shutdown command sent to VM '${status.name}'`, 
        previous_state: status.power_state,
        note: "Use wait_timeout parameter to wait for shutdown completion"
      };
    }
    
    // Poll for shutdown with timeout
    const startTime = Date.now();
    const pollInterval = 3000; // 3 seconds
    const maxWait = Math.min(wait_timeout, 300) * 1000; // Cap at 5 minutes
    
    while (Date.now() - startTime < maxWait) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      const currentStatus = await this.getVMStatus(id);
      
      if (!currentStatus.running) {
        return { 
          success: true, 
          message: `VM '${status.name}' shut down gracefully`, 
          final_state: currentStatus.power_state,
          elapsed_seconds: Math.round((Date.now() - startTime) / 1000)
        };
      }
    }
    
    // Timeout reached - check if we should force
    if (force_after_timeout) {
      await this.vmAction(id, "kill");
      // Wait a moment for kill to take effect
      await new Promise(resolve => setTimeout(resolve, 2000));
      const finalStatus = await this.getVMStatus(id);
      return { 
        success: true, 
        message: `VM '${status.name}' did not shut down within ${wait_timeout}s - forced power off`, 
        final_state: finalStatus.power_state,
        forced: true,
        elapsed_seconds: Math.round((Date.now() - startTime) / 1000)
      };
    }
    
    // Timeout without force
    const currentStatus = await this.getVMStatus(id);
    return { 
      success: false, 
      error: `VM '${status.name}' did not shut down within ${wait_timeout}s`, 
      current_state: currentStatus.power_state,
      elapsed_seconds: Math.round((Date.now() - startTime) / 1000),
      hint: "Use force_after_timeout=true to automatically force shutdown after timeout"
    };
  }
  
  async forceOffVM(id) {
    const status = await this.getVMStatus(id);
    if (!status.running) {
      return { success: true, message: `VM '${status.name}' is already stopped`, current_state: status.power_state };
    }
    await this.vmAction(id, "kill");
    return { success: true, message: `Force power off (kill) command sent to VM '${status.name}'`, previous_state: status.power_state };
  }
  
  async resetVM(id) {
    const status = await this.getVMStatus(id);
    if (!status.running) {
      return { success: false, error: `VM '${status.name}' is not running - cannot reset`, current_state: status.power_state };
    }
    await this.vmAction(id, "reset");
    return { success: true, message: `Reset command sent to VM '${status.name}'`, previous_state: status.power_state };
  }
  async getVMNics(vmId) {
    // Get VM to find machine ID
    const vm = await this.getVM(vmId);
    const machineId = vm.machine;
    const nics = await this.request(`/api/v4/machine_nics?machine=${machineId}&fields=all`);
    return nics.filter((nic) => nic.machine === machineId).map(n => ({
      id: n.$key,
      name: n.name,
      mac: n.macaddress,
      network_id: n.vnet,
      ip: n.ipaddress,
      interface: n.interface,
      enabled: n.enabled,
    }));
  }
  async getVMDrives(machineId) {
    const drives = await this.request(`/api/v4/machine_drives?machine=${machineId}&fields=all`);
    // Filter by machine ID and return simplified info
    return drives
      .filter((d) => d.machine === machineId)
      .map((d) => ({
        id: d.$key,
        name: d.name,
        interface: d.interface,
        size_gb: d.disksize ? Math.round(d.disksize / (1024 * 1024 * 1024)) : null,
        size_bytes: d.disksize || null,
        enabled: d.enabled,
        media_type: d.media_type,
        description: d.description || "",
      }));
  }
  
  async resizeDrive(driveId, newSizeGB) {
    // Get current drive info
    const drive = await this.request(`/api/v4/machine_drives/${driveId}?fields=all`);
    if (!drive) {
      return { success: false, error: `Drive ${driveId} not found` };
    }
    
    const currentSizeGB = Math.round(drive.disksize / (1024 * 1024 * 1024));
    const newSizeBytes = newSizeGB * 1024 * 1024 * 1024;
    
    if (newSizeGB <= currentSizeGB) {
      return { 
        success: false, 
        error: `New size (${newSizeGB} GB) must be larger than current size (${currentSizeGB} GB). Shrinking disks is not supported.`,
        current_size_gb: currentSizeGB
      };
    }
    
    // Resize the drive
    await this.request(`/api/v4/machine_drives/${driveId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disksize: newSizeBytes }),
    });
    
    return { 
      success: true, 
      message: `Drive '${drive.name}' resized from ${currentSizeGB} GB to ${newSizeGB} GB`,
      drive_id: driveId,
      previous_size_gb: currentSizeGB,
      new_size_gb: newSizeGB,
      note: "You may need to extend the partition/filesystem inside the VM to use the new space"
    };
  }
  
  async addDrive(machineId, options = {}) {
    const { name, size_gb, interface_type = "virtio-scsi", description = "" } = options;
    
    if (!name) {
      return { success: false, error: "Drive name is required" };
    }
    if (!size_gb || size_gb < 1) {
      return { success: false, error: "Size in GB is required and must be at least 1 GB" };
    }
    
    const sizeBytes = size_gb * 1024 * 1024 * 1024;
    
    // Create the drive
    const result = await this.request("/api/v4/machine_drives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        machine: machineId,
        name: name,
        disksize: sizeBytes,
        interface: interface_type,
        media: "disk",
        description: description,
        enabled: true,
      }),
    });
    
    return { 
      success: true, 
      message: `Drive '${name}' (${size_gb} GB) added to machine ${machineId}`,
      drive_id: result.$key,
      name: name,
      size_gb: size_gb,
      interface: interface_type,
      note: "The VM may need to be restarted to detect the new drive"
    };
  }
  
  async modifyVM(vmId, options = {}) {
    const { cpu_cores, ram_mb, shutdown_if_running = false, wait_timeout = 60, force_after_timeout = true } = options;
    
    if (!cpu_cores && !ram_mb) {
      return { success: false, error: "Must specify cpu_cores and/or ram_mb to modify" };
    }
    
    // Get current VM info and status
    const vm = await this.getVM(vmId);
    const status = await this.getVMStatus(vmId);
    
    const changes = {};
    if (cpu_cores) changes.cpu_cores = cpu_cores;
    if (ram_mb) changes.ram = ram_mb;
    
    // Check if VM is running
    if (status.running) {
      if (!shutdown_if_running) {
        return {
          success: false,
          error: `VM '${vm.name}' is currently running. CPU/RAM changes require the VM to be powered off.`,
          current_state: status.power_state,
          current_cpu: vm.cpu_cores,
          current_ram_mb: vm.ram,
          requested_cpu: cpu_cores || vm.cpu_cores,
          requested_ram_mb: ram_mb || vm.ram,
          hint: "Set shutdown_if_running=true to automatically shut down the VM, apply changes, and optionally restart it"
        };
      }
      
      // Shut down the VM
      const shutdownResult = await this.powerOffVM(vmId, { wait_timeout, force_after_timeout });
      if (!shutdownResult.success && !shutdownResult.message?.includes("already stopped")) {
        return {
          success: false,
          error: `Failed to shut down VM '${vm.name}': ${shutdownResult.error}`,
          shutdown_result: shutdownResult
        };
      }
    }
    
    // Apply changes
    await this.request(`/api/v4/vms/${vmId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    
    return {
      success: true,
      message: `VM '${vm.name}' modified successfully`,
      vm_id: vmId,
      previous_cpu: vm.cpu_cores,
      previous_ram_mb: vm.ram,
      new_cpu: cpu_cores || vm.cpu_cores,
      new_ram_mb: ram_mb || vm.ram,
      was_running: status.running,
      note: status.running ? "VM was shut down to apply changes. Use power_on_vm to restart it." : "VM is stopped. Use power_on_vm to start it with new settings."
    };
  }

  // Network Operations
  async listNetworks(options = {}) {
    const { type, name, enabled, limit = 100, offset = 0 } = options;
    const networks = await this.request("/api/v4/vnets?fields=most");
    
    // Filter
    let filtered = networks;
    if (type) filtered = filtered.filter(n => n.type === type);
    if (name) filtered = filtered.filter(n => n.name?.toLowerCase().includes(name.toLowerCase()));
    if (enabled !== undefined) filtered = filtered.filter(n => n.enabled === enabled);
    
    // Paginate and return summary view
    return filtered.slice(offset, offset + limit).map(n => ({
      id: n.$key,
      name: n.name,
      type: n.type,
      network: n.network,
      enabled: n.enabled,
      running: n.running,
      description: n.description || null,
    }));
  }
  async getNetwork(id) { return this.request(`/api/v4/vnets/${id}?fields=most`); }
  async networkAction(id, action) {
    return this.request("/api/v4/vnet_actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vnet: id, action }),
    });
  }

  // Tenant Operations
  async listTenants() { return this.request("/api/v4/tenants?fields=most"); }
  async getTenant(id) { return this.request(`/api/v4/tenants/${id}?fields=most`); }
  async tenantAction(id, action) {
    return this.request("/api/v4/tenant_actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenant: id, action }),
    });
  }

  // Node/Cluster Operations
  async listNodes() { return this.request("/api/v4/nodes?fields=most"); }
  async getNodeStats(id) { return this.request(`/api/v4/node_stats?node=${id}`); }
  async getClusterStatus() { return this.request("/api/v4/cluster_status"); }
  async getClusterStats() { return this.request("/api/v4/cluster_tier_stats"); }

  // Storage & Monitoring
  async listVolumes() { return this.request("/api/v4/volumes?fields=most"); }
  async getLogs(options = {}) {
    const { limit = 50, level, object_type } = options;
    // Fetch more logs if filtering, then apply client-side filter
    const fetchLimit = (level || object_type) ? Math.min(limit * 5, 500) : limit;
    const logs = await this.request(`/api/v4/logs?fields=all&limit=${fetchLimit}&sort=-$key`);
    
    let filtered = logs;
    if (level) filtered = filtered.filter(log => log.level === level);
    if (object_type) filtered = filtered.filter(log => log.object_type === object_type);
    
    return filtered.slice(0, limit).map(log => ({
      id: log.$key,
      timestamp: log.dbtime,
      level: log.level,
      text: log.text,
      user: log.user,
      object_type: log.object_type,
      object_name: log.object_name,
    }));
  }
  async getAlarms() { return this.request("/api/v4/alarms?fields=most"); }

  // Snapshot methods
  async listVMSnapshots(vmId) {
    const vm = await this.getVM(vmId);
    const machineId = vm.machine;
    const snapshots = await this.request(`/api/v4/machine_snapshots?machine=${machineId}&fields=most`);
    return snapshots.filter(s => s.machine === machineId).map(s => ({
      id: s.$key,
      name: s.name,
      description: s.description || "",
      created: s.dbtime,
      expires: s.expires_type === "never" ? "never" : s.expires,
      quiesced: s.quiesced || false,
      size_bytes: s.size,
    }));
  }

  async createVMSnapshot(vmId, options = {}) {
    const { name, description = "", expires_days = 7, quiesce = false } = options;
    const vm = await this.getVM(vmId);
    const machineId = vm.machine;
    
    if (!name) throw new Error("Snapshot name is required");
    
    const expiresTimestamp = expires_days > 0 
      ? Math.floor(Date.now() / 1000) + (expires_days * 86400)
      : null;
    
    const body = {
      machine: machineId,
      name: name,
      description: description,
      expires_type: expires_days > 0 ? "date" : "never",
      quiesce: quiesce,
      created_manually: true,
    };
    
    if (expiresTimestamp) body.expires = expiresTimestamp;
    
    const result = await this.request("/api/v4/machine_snapshots", {
      method: "POST",
      body: JSON.stringify(body),
    });
    
    return {
      success: true,
      snapshot_id: result.$key,
      message: `Snapshot '${name}' created for VM '${vm.name}'`,
      vm_id: vmId,
      vm_name: vm.name,
      quiesce: quiesce,
      expires: expires_days > 0 ? `${expires_days} days` : "never",
    };
  }

  async deleteVMSnapshot(snapshotId) {
    await this.request(`/api/v4/machine_snapshots/${snapshotId}`, { method: "DELETE" });
    return { success: true, message: `Snapshot ${snapshotId} deleted` };
  }

  async restoreVMSnapshot(vmId, snapshotId) {
    const result = await this.request("/api/v4/vm_actions", {
      method: "POST",
      body: JSON.stringify({ vm: vmId, action: "restore", params: { snapshot: snapshotId } }),
    });
    return { success: true, message: `VM ${vmId} restore from snapshot ${snapshotId} initiated`, result };
  }

}

// Initialize API
const api = new VergeOSAPI();

// MCP Tools Definition
const TOOLS = [
  { name: "list_vms", description: "List all virtual machines in VergeOS. Can filter by running status or name.", inputSchema: { type: "object", properties: { running: { type: "boolean", description: "Filter to only running VMs" }, name: { type: "string", description: "Filter by VM name" } } } },
  { name: "get_vm", description: "Get detailed information about a specific VM by ID", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "get_vm_status", description: "Get the current status of a VM", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "power_on_vm", description: "Power on a virtual machine", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "power_off_vm", description: "Power off a virtual machine (graceful shutdown). Use wait_timeout to wait for completion, and force_after_timeout to auto-force if graceful shutdown fails.", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" }, wait_timeout: { type: "number", description: "Seconds to wait for graceful shutdown (0 = don't wait, max 300). Recommended: 60-120 for most VMs." }, force_after_timeout: { type: "boolean", description: "If true, force power off after wait_timeout expires. Recommended: true for reliable shutdown." } }, required: ["id"] } },
  { name: "force_off_vm", description: "Force power off a VM (hard shutdown - use when graceful shutdown fails)", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "reset_vm", description: "Reset/reboot a virtual machine", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "get_vm_nics", description: "Get network interfaces for a VM", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" } }, required: ["id"] } },
  { name: "get_vm_drives", description: "Get disk drives for a VM (use machine ID, not VM ID)", inputSchema: { type: "object", properties: { id: { type: "number", description: "Machine ID (from VM's 'machine' field)" } }, required: ["id"] } },
  { name: "resize_drive", description: "Resize a VM disk drive (increase only). Get drive IDs from get_vm_drives first.", inputSchema: { type: "object", properties: { drive_id: { type: "number", description: "Drive ID (from get_vm_drives)" }, new_size_gb: { type: "number", description: "New size in GB (must be larger than current size)" } }, required: ["drive_id", "new_size_gb"] } },
  { name: "add_drive", description: "Add a new disk drive to a VM. Use machine ID (from VM's 'machine' field), not VM ID.", inputSchema: { type: "object", properties: { machine_id: { type: "number", description: "Machine ID (from VM's 'machine' field)" }, name: { type: "string", description: "Drive name (e.g., 'data-disk')" }, size_gb: { type: "number", description: "Size in GB" }, interface_type: { type: "string", enum: ["virtio-scsi", "virtio", "ide", "ahci"], description: "Interface type (default: virtio-scsi)" }, description: { type: "string", description: "Optional description" } }, required: ["machine_id", "name", "size_gb"] } },
  { name: "modify_vm", description: "Modify VM CPU cores and/or RAM. If VM is running, set shutdown_if_running=true to auto-shutdown, apply changes, then you can restart.", inputSchema: { type: "object", properties: { id: { type: "number", description: "VM ID" }, cpu_cores: { type: "number", description: "New number of CPU cores" }, ram_mb: { type: "number", description: "New RAM in MB (e.g., 4096 for 4GB)" }, shutdown_if_running: { type: "boolean", description: "If true and VM is running, shut it down first to apply changes" }, wait_timeout: { type: "number", description: "Seconds to wait for shutdown (default: 60)" }, force_after_timeout: { type: "boolean", description: "Force shutdown if graceful fails (default: true)" } }, required: ["id"] } },
  { name: "list_networks", description: "List virtual networks (summary view). Use get_network for full details.", inputSchema: { type: "object", properties: { type: { type: "string", description: "Filter by network type (e.g., 'internal', 'external', 'core', 'dmz')" }, name: { type: "string", description: "Filter by name (partial match)" }, enabled: { type: "boolean", description: "Filter by enabled status" }, limit: { type: "number", description: "Max results (default 100)" }, offset: { type: "number", description: "Skip first N results (for pagination)" } } } },
  { name: "get_network", description: "Get network details", inputSchema: { type: "object", properties: { id: { type: "number", description: "Network ID" } }, required: ["id"] } },
  { name: "network_action", description: "Perform network action (poweron, poweroff, reset, apply)", inputSchema: { type: "object", properties: { id: { type: "number" }, action: { type: "string", enum: ["poweron", "poweroff", "reset", "apply"] } }, required: ["id", "action"] } },
  { name: "list_tenants", description: "List all tenants", inputSchema: { type: "object", properties: {} } },
  { name: "get_tenant", description: "Get tenant details", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "tenant_action", description: "Perform tenant action", inputSchema: { type: "object", properties: { id: { type: "number" }, action: { type: "string", enum: ["poweron", "poweroff", "reset"] } }, required: ["id", "action"] } },
  { name: "list_nodes", description: "List cluster nodes", inputSchema: { type: "object", properties: {} } },
  { name: "get_node_stats", description: "Get node statistics", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "get_cluster_status", description: "Get cluster status", inputSchema: { type: "object", properties: {} } },
  { name: "get_cluster_stats", description: "Get cluster tier stats", inputSchema: { type: "object", properties: {} } },
  { name: "list_volumes", description: "List storage volumes", inputSchema: { type: "object", properties: {} } },
  { name: "get_logs", description: "Get system logs with optional filtering", inputSchema: { type: "object", properties: { limit: { type: "number", description: "Number of logs (default 50)" }, level: { type: "string", enum: ["audit", "message", "warning", "error", "critical", "summary", "debug"], description: "Filter by log level" }, object_type: { type: "string", enum: ["vm", "vnet", "tenant", "node", "cluster", "user", "system", "task"], description: "Filter by object type" } } } },
  { name: "get_alarms", description: "Get active alarms", inputSchema: { type: "object", properties: {} } },
  { name: "list_vm_snapshots", description: "List snapshots for a VM", inputSchema: { type: "object", properties: { vm_id: { type: "number", description: "VM ID" } }, required: ["vm_id"] } },
  { name: "create_vm_snapshot", description: "Create a snapshot of a VM", inputSchema: { type: "object", properties: { vm_id: { type: "number", description: "VM ID" }, name: { type: "string", description: "Snapshot name" }, description: { type: "string", description: "Optional description" }, expires_days: { type: "number", description: "Days until expiration (0 for never, default 7)" }, quiesce: { type: "boolean", description: "Quiesce VM before snapshot (requires guest agent)" } }, required: ["vm_id", "name"] } },
  { name: "delete_vm_snapshot", description: "Delete a VM snapshot", inputSchema: { type: "object", properties: { snapshot_id: { type: "number", description: "Snapshot ID" } }, required: ["snapshot_id"] } },
  { name: "restore_vm_snapshot", description: "Restore a VM from a snapshot", inputSchema: { type: "object", properties: { vm_id: { type: "number", description: "VM ID" }, snapshot_id: { type: "number", description: "Snapshot ID to restore" } }, required: ["vm_id", "snapshot_id"] } },
];

// Execute tool
async function executeTool(name, args) {
  switch (name) {
    case "list_vms": return api.listVMs(args);
    case "get_vm": return api.getVM(args.id);
    case "get_vm_status": return api.getVMStatus(args.id);
    case "power_on_vm": return api.powerOnVM(args.id);
    case "power_off_vm": return api.powerOffVM(args.id, { wait_timeout: args.wait_timeout, force_after_timeout: args.force_after_timeout });
    case "force_off_vm": return api.forceOffVM(args.id);
    case "reset_vm": return api.resetVM(args.id);
    case "get_vm_nics": return api.getVMNics(args.id);
    case "get_vm_drives": return api.getVMDrives(args.id);
    case "resize_drive": return api.resizeDrive(args.drive_id, args.new_size_gb);
    case "add_drive": return api.addDrive(args.machine_id, { name: args.name, size_gb: args.size_gb, interface_type: args.interface_type, description: args.description });
    case "modify_vm": return api.modifyVM(args.id, { cpu_cores: args.cpu_cores, ram_mb: args.ram_mb, shutdown_if_running: args.shutdown_if_running, wait_timeout: args.wait_timeout, force_after_timeout: args.force_after_timeout });
    case "list_networks": return api.listNetworks({ type: args.type, name: args.name, enabled: args.enabled, limit: args.limit, offset: args.offset });
    case "get_network": return api.getNetwork(args.id);
    case "network_action": return api.networkAction(args.id, args.action);
    case "list_tenants": return api.listTenants();
    case "get_tenant": return api.getTenant(args.id);
    case "tenant_action": return api.tenantAction(args.id, args.action);
    case "list_nodes": return api.listNodes();
    case "get_node_stats": return api.getNodeStats(args.id);
    case "get_cluster_status": return api.getClusterStatus();
    case "get_cluster_stats": return api.getClusterStats();
    case "list_volumes": return api.listVolumes();
    case "get_logs": return api.getLogs({ limit: args?.limit || 50, level: args?.level, object_type: args?.object_type });
    case "get_alarms": return api.getAlarms();
    case "list_vm_snapshots": return api.listVMSnapshots(args.vm_id);
    case "create_vm_snapshot": return api.createVMSnapshot(args.vm_id, args);
    case "delete_vm_snapshot": return api.deleteVMSnapshot(args.snapshot_id);
    case "restore_vm_snapshot": return api.restoreVMSnapshot(args.vm_id, args.snapshot_id);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Store active SSE sessions
const sessions = new Map();

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "vergeos-mcp-server", vergeosHost: VERGEOS_HOST });
});

// MCP SSE endpoint - for establishing SSE connection
app.get("/sse", (req, res) => {
  const sessionId = randomUUID();
  
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Session-Id", sessionId);
  
  // Send session ID
  res.write(`data: ${JSON.stringify({ type: "session", sessionId })}\n\n`);
  
  // Store session
  sessions.set(sessionId, res);
  
  // Cleanup on close
  req.on("close", () => {
    sessions.delete(sessionId);
  });
});

// MCP message endpoint - for receiving requests
app.post("/message", async (req, res) => {
  const message = req.body;
  
  try {
    let response;
    
    switch (message.method) {
      case "initialize":
        response = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "vergeos-mcp-server", version: "1.0.0" },
          },
        };
        break;
        
      case "tools/list":
        response = {
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: TOOLS },
        };
        break;
        
      case "tools/call":
        try {
          const result = await executeTool(message.params.name, message.params.arguments || {});
          response = {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            },
          };
        } catch (error) {
          response = {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: `Error: ${error.message}` }],
              isError: true,
            },
          };
        }
        break;
        
      case "resources/list":
        response = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resources: [
              { uri: "vergeos://cluster/status", name: "Cluster Status", mimeType: "application/json" },
              { uri: "vergeos://vms/list", name: "Virtual Machines", mimeType: "application/json" },
            ],
          },
        };
        break;
        
      default:
        response = {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        };
    }
    
    res.json(response);
  } catch (error) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32603, message: error.message },
    });
  }
});

// Legacy REST endpoints (for direct API access)
app.get("/tools", (req, res) => res.json({ tools: TOOLS }));
app.post("/tools/:name", async (req, res) => {
  try {
    const result = await executeTool(req.params.name, req.body || {});
    res.json({ result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/vms", async (req, res) => {
  try { res.json(await api.listVMs(req.query)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/vms/:id", async (req, res) => {
  try { res.json(await api.getVM(parseInt(req.params.id))); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/vms/:id/:action", async (req, res) => {
  try { res.json(await api.vmAction(parseInt(req.params.id), req.params.action)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/networks", async (req, res) => {
  try { res.json(await api.listNetworks()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/tenants", async (req, res) => {
  try { res.json(await api.listTenants()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/nodes", async (req, res) => {
  try { res.json(await api.listNodes()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/cluster/status", async (req, res) => {
  try { res.json(await api.getClusterStatus()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/alarms", async (req, res) => {
  try { res.json(await api.getAlarms()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/logs", async (req, res) => {
  try { res.json(await api.getLogs(parseInt(req.query.limit) || 50)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start server
app.listen(PORT, () => {
  console.log("===========================================");
  console.log("VergeOS MCP Server (HTTP+SSE Mode)");
  console.log("===========================================");
  console.log(`Server running on: http://localhost:${PORT}`);
  console.log(`VergeOS endpoint: https://${VERGEOS_HOST}`);
  console.log("");
  console.log("MCP Endpoints:");
  console.log("  GET  /sse      - SSE connection");
  console.log("  POST /message  - MCP JSON-RPC messages");
  console.log("");
  console.log("REST Endpoints:");
  console.log("  GET  /health, /tools, /vms, /networks, etc.");
  console.log("===========================================");
});
