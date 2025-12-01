#!/usr/bin/env node

// Quick test script for VergeOS API connectivity
import https from "https";
import { config } from "dotenv";

config({ override: true });

const VERGEOS_HOST = process.env.VERGEOS_HOST || "192.168.1.111";
const VERGEOS_USER = process.env.VERGEOS_USER || "";
const VERGEOS_PASS = process.env.VERGEOS_PASS || "";
let VERGEOS_TOKEN = process.env.VERGEOS_TOKEN || "";

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

async function getToken() {
  // Always get fresh token if we have user/pass
  if (VERGEOS_USER && VERGEOS_PASS) {
    const fetch = (await import("node-fetch")).default;
    const response = await fetch(`https://${VERGEOS_HOST}/api/sys/tokens`, {
      method: "POST",
      agent: httpsAgent,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${VERGEOS_USER}:${VERGEOS_PASS}`).toString("base64"),
      },
      body: JSON.stringify({ login: VERGEOS_USER, password: VERGEOS_PASS }),
    });
    const data = await response.json();
    VERGEOS_TOKEN = data.$key;
    return VERGEOS_TOKEN;
  }
  return VERGEOS_TOKEN;
}

async function test() {
  console.log("Testing VergeOS MCP Server API Connection");
  console.log("==========================================");
  console.log(`Host: ${VERGEOS_HOST}`);
  console.log(`User: ${VERGEOS_USER || "NOT SET"}`);
  
  const fetch = (await import("node-fetch")).default;
  
  // Get token
  const token = await getToken();
  console.log(`Token: ${token ? token.substring(0, 10) + "..." : "FAILED"}`);
  console.log("");

  try {
    // Test 1: List VMs
    console.log("1. Testing VM List...");
    const vmResponse = await fetch(`https://${VERGEOS_HOST}/api/v4/vms?fields=name,is_running,is_snapshot`, {
      agent: httpsAgent,
      headers: {
        Cookie: `token=${token}`,
      },
    });
    const vms = await vmResponse.json();
    const realVMs = vms.filter((vm) => !vm.is_snapshot);
    console.log(`   ✓ Found ${realVMs.length} VMs (${vms.length} total including templates)`);
    realVMs.slice(0, 3).forEach((vm) => {
      console.log(`     - ${vm.name} (running: ${vm.is_running})`);
    });
    console.log("");

    // Test 2: List Networks
    console.log("2. Testing Network List...");
    const netResponse = await fetch(`https://${VERGEOS_HOST}/api/v4/vnets?fields=name,is_running`, {
      agent: httpsAgent,
      headers: {
        Cookie: `token=${token}`,
      },
    });
    const networks = await netResponse.json();
    console.log(`   ✓ Found ${networks.length} networks`);
    networks.slice(0, 3).forEach((net) => {
      console.log(`     - ${net.name} (running: ${net.is_running})`);
    });
    console.log("");

    // Test 3: Cluster Status
    console.log("3. Testing Cluster Status...");
    const clusterResponse = await fetch(`https://${VERGEOS_HOST}/api/v4/cluster_status`, {
      agent: httpsAgent,
      headers: {
        Cookie: `token=${token}`,
      },
    });
    const cluster = await clusterResponse.json();
    console.log(`   ✓ Cluster status retrieved`);
    if (cluster.length > 0) {
      console.log(`     - Cluster ID: ${cluster[0].cluster}`);
    }
    console.log("");

    // Test 4: Nodes
    console.log("4. Testing Node List...");
    const nodeResponse = await fetch(`https://${VERGEOS_HOST}/api/v4/nodes?fields=name,is_online`, {
      agent: httpsAgent,
      headers: {
        Cookie: `token=${token}`,
      },
    });
    const nodes = await nodeResponse.json();
    console.log(`   ✓ Found ${nodes.length} nodes`);
    nodes.forEach((node) => {
      console.log(`     - ${node.name} (online: ${node.is_online})`);
    });
    console.log("");

    console.log("==========================================");
    console.log("All tests passed! MCP Server should work.");
    console.log("");

  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

test();
