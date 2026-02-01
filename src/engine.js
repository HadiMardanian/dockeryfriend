const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const yaml = require("js-yaml");

const DEFAULT_STATE_PATH = ".nexus/state.json";

function loadManifest(manifestPath) {
  const absolutePath = path.resolve(manifestPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const raw = fs.readFileSync(absolutePath, "utf8");
  const manifest = yaml.load(raw);
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Invalid manifest: expected a YAML object");
  }
  if (!manifest.services || !manifest.intents) {
    throw new Error("Invalid manifest: missing services or intents");
  }
  return {
    manifest,
    manifestPath: absolutePath,
    projectRoot: path.dirname(absolutePath),
    manifestHash: hashString(raw),
  };
}

function resolveIntentName(manifest, intentName) {
  const intents = Object.keys(manifest.intents || {});
  if (intentName) {
    if (!manifest.intents[intentName]) {
      throw new Error(`Intent not found: ${intentName}`);
    }
    return intentName;
  }
  if (manifest.defaultIntent && manifest.intents[manifest.defaultIntent]) {
    return manifest.defaultIntent;
  }
  if (manifest.intents.feature) {
    return "feature";
  }
  if (intents.length > 0) {
    return intents[0];
  }
  throw new Error("No intents defined in manifest");
}

function buildPlan(manifest, intentName) {
  const intent = manifest.intents[intentName];
  if (!intent || !intent.desired || !intent.desired.services) {
    throw new Error(`Intent has no desired services: ${intentName}`);
  }
  const plan = [];
  for (const [serviceName, desired] of Object.entries(intent.desired.services)) {
    const service = manifest.services[serviceName];
    if (!service) {
      throw new Error(`Service not found: ${serviceName}`);
    }
    const stateIds = Array.isArray(desired.states) ? desired.states : [];
    for (const stateId of stateIds) {
      const state = service.states && service.states[stateId];
      if (!state || !state.type) {
        throw new Error(`State not found: ${serviceName}.${stateId}`);
      }
      plan.push({
        serviceName,
        stateId,
        type: state.type,
        config: state,
        service,
      });
    }
  }
  return plan;
}

function buildGraph(manifest) {
  const edges = [];
  const seen = new Set();
  for (const [serviceName, service] of Object.entries(manifest.services || {})) {
    const requires = (service.requires && service.requires.services) || [];
    for (const required of requires) {
      addEdge(edges, seen, serviceName, required, "requires");
    }
    const consumes = (service.consumes && service.consumes.env) || {};
    for (const [varName, binding] of Object.entries(consumes)) {
      const from = binding && binding.from;
      if (typeof from === "string" && from.includes(".")) {
        const provider = from.split(".")[0];
        addEdge(edges, seen, serviceName, provider, `consumes ${varName}`);
      }
    }
  }
  return edges;
}

function addEdge(edges, seen, from, to, reason) {
  const key = `${from}->${to}:${reason}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  edges.push({ from, to, reason });
}

async function validatePlan(plan, projectRoot) {
  const results = [];
  for (const item of plan) {
    const observation = await observeState(item, projectRoot);
    results.push({ ...item, observation });
  }
  return results;
}

async function observeState(item, projectRoot) {
  const serviceRoot = item.service.root || ".";
  const resolvedRoot = path.resolve(projectRoot, serviceRoot);
  const type = item.type;

  if (type === "package.deps") {
    const lockfile = item.config.lockfile || "package-lock.json";
    const lockfilePath = path.join(resolvedRoot, lockfile);
    if (!fs.existsSync(lockfilePath)) {
      return {
        status: "missing",
        evidence: { lockfile: lockfilePath, exists: false },
      };
    }
    return {
      status: "healthy",
      evidence: {
        lockfile: lockfilePath,
        checksum: hashFile(lockfilePath),
      },
    };
  }

  if (type === "db.schema") {
    const source = item.config.source;
    if (!source) {
      return { status: "unknown", evidence: { reason: "no source defined" } };
    }
    const schemaPath = path.resolve(resolvedRoot, source);
    const exists = fs.existsSync(schemaPath);
    return {
      status: exists ? "healthy" : "missing",
      evidence: {
        source: schemaPath,
        exists,
        checksum: exists ? hashFile(schemaPath) : undefined,
      },
    };
  }

  if (type === "env.export") {
    const keys = Array.isArray(item.config.keys) ? item.config.keys : [];
    return {
      status: keys.length > 0 ? "healthy" : "missing",
      evidence: { keys },
    };
  }

  if (type === "env.inherit") {
    const from = item.config.from;
    return {
      status: from ? "healthy" : "missing",
      evidence: { from },
    };
  }

  if (type === "process.http") {
    const port = Number(item.config.port);
    const host = item.config.host || "127.0.0.1";
    if (!Number.isFinite(port)) {
      return { status: "unknown", evidence: { reason: "invalid port" } };
    }
    const isOpen = await checkPort(host, port, 300);
    return {
      status: isOpen ? "healthy" : "missing",
      evidence: { host, port, open: isOpen },
    };
  }

  return { status: "unknown", evidence: { type } };
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  const absolutePath = path.resolve(statePath);
  if (!fs.existsSync(absolutePath)) {
    return { manifestHash: null, observations: {} };
  }
  const raw = fs.readFileSync(absolutePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid state file: ${absolutePath}`);
  }
}

function writeState(state, statePath = DEFAULT_STATE_PATH) {
  const absolutePath = path.resolve(statePath);
  const dir = path.dirname(absolutePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(state, null, 2));
}

function updateState(existingState, results, manifestHash) {
  const now = new Date().toISOString();
  const next = {
    manifestHash,
    observations: {},
  };
  for (const result of results) {
    const key = `${result.serviceName}:${result.stateId}`;
    const previous = existingState.observations
      ? existingState.observations[key]
      : null;
    next.observations[key] = {
      status: result.observation.status,
      evidence: result.observation.evidence,
      lastValidatedAt: now,
      lastAppliedAt: previous ? previous.lastAppliedAt : null,
    };
  }
  return next;
}

function summarizeResults(results) {
  const summary = { healthy: 0, missing: 0, unknown: 0 };
  for (const result of results) {
    const status = result.observation.status;
    if (status === "healthy") summary.healthy += 1;
    else if (status === "missing") summary.missing += 1;
    else summary.unknown += 1;
  }
  summary.total = results.length;
  return summary;
}

function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  return `sha256:${crypto.createHash("sha256").update(data).digest("hex")}`;
}

function hashString(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function checkPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.connect(port, host, () => finish(true));
  });
}

module.exports = {
  DEFAULT_STATE_PATH,
  buildGraph,
  buildPlan,
  loadManifest,
  loadState,
  resolveIntentName,
  summarizeResults,
  updateState,
  validatePlan,
  writeState,
};
