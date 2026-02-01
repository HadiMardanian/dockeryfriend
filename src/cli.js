const path = require("path");
const {
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
} = require("./engine");

async function run(argv) {
  const args = parseArgs(argv);
  const command = args._[0] || "help";

  if (args.help || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "status") {
    await handleStatus(args);
    return;
  }

  if (command === "graph") {
    await handleGraph(args);
    return;
  }

  if (command === "dev" || command === "sync") {
    await handleLifecycle(args, command);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function handleStatus(args) {
  const manifestPath = resolveManifestPath(args);
  const { manifest, manifestHash, projectRoot } = loadManifest(manifestPath);
  const intentName = resolveIntentName(manifest, args.intent);
  const plan = buildPlan(manifest, intentName);
  const results = await validatePlan(plan, projectRoot);
  const summary = summarizeResults(results);
  const state = loadState(DEFAULT_STATE_PATH);
  const stale = state.manifestHash && state.manifestHash !== manifestHash;

  if (args.json) {
    printJson({
      manifest: path.resolve(manifestPath),
      intent: intentName,
      manifestHash,
      stateHash: state.manifestHash || null,
      stateStale: stale,
      summary,
      results: results.map(formatResultJson),
    });
    return;
  }

  console.log(`Nexus status (intent: ${intentName})`);
  console.log(`Manifest: ${path.resolve(manifestPath)}`);
  console.log(`Manifest hash: ${manifestHash}`);
  if (state.manifestHash) {
    console.log(`State: ${DEFAULT_STATE_PATH}${stale ? " (stale)" : ""}`);
  } else {
    console.log(`State: ${DEFAULT_STATE_PATH} (missing)`);
  }
  console.log("");
  printResults(results);
  console.log("");
  printSummary(summary);
}

async function handleGraph(args) {
  const manifestPath = resolveManifestPath(args);
  const { manifest } = loadManifest(manifestPath);
  const edges = buildGraph(manifest);

  if (args.json) {
    printJson({ edges });
    return;
  }

  console.log("Nexus graph");
  if (edges.length === 0) {
    console.log("No edges found.");
    return;
  }
  for (const edge of edges) {
    console.log(`${edge.from} -> ${edge.to} (${edge.reason})`);
  }
}

async function handleLifecycle(args, mode) {
  const manifestPath = resolveManifestPath(args);
  const { manifest, manifestHash, projectRoot } = loadManifest(manifestPath);
  const intentName = resolveIntentName(manifest, args.intent);
  const plan = buildPlan(manifest, intentName);
  const results = await validatePlan(plan, projectRoot);
  const summary = summarizeResults(results);
  const state = loadState(DEFAULT_STATE_PATH);
  const nextState = updateState(state, results, manifestHash);
  writeState(nextState, DEFAULT_STATE_PATH);

  if (args.json) {
    printJson({
      mode,
      intent: intentName,
      summary,
      results: results.map(formatResultJson),
      state: DEFAULT_STATE_PATH,
    });
    return;
  }

  console.log(`Nexus ${mode} (intent: ${intentName})`);
  console.log(`Resolved ${results.length} states.`);
  printSummary(summary);
  const pending = summary.missing + summary.unknown;
  if (pending > 0) {
    const types = listPendingTypes(results);
    console.log("");
    console.log("No reconcilers registered for:");
    for (const type of types) {
      console.log(`- ${type}`);
    }
    console.log("Use plugins to reconcile missing states.");
    process.exitCode = 1;
  }
  console.log("");
  console.log(`State saved to ${DEFAULT_STATE_PATH}`);
}

function parseArgs(argv) {
  const args = {
    _: [],
    manifest: null,
    intent: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--manifest" || arg === "-m") {
      args.manifest = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--manifest=")) {
      args.manifest = arg.split("=")[1];
      continue;
    }
    if (arg === "--intent" || arg === "-i") {
      args.intent = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--intent=")) {
      args.intent = arg.split("=")[1];
      continue;
    }
    args._.push(arg);
  }
  return args;
}

function resolveManifestPath(args) {
  return args.manifest || process.env.NEXUS_MANIFEST || "nexus.yaml";
}

function printHelp() {
  console.log("Usage: nexus <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  status            Show desired vs observed state");
  console.log("  graph             Show dependency graph");
  console.log("  dev               Resolve and persist local state");
  console.log("  sync              Align local state to manifest");
  console.log("");
  console.log("Options:");
  console.log("  -m, --manifest    Path to nexus.yaml");
  console.log("  -i, --intent      Intent name to resolve");
  console.log("  --json            JSON output");
  console.log("  -h, --help        Show help");
  console.log("");
  console.log("Environment:");
  console.log("  NEXUS_MANIFEST    Default manifest path");
}

function printResults(results) {
  if (results.length === 0) {
    console.log("No states resolved.");
    return;
  }
  for (const result of results) {
    const key = `${result.serviceName}:${result.stateId}`;
    const status = result.observation.status;
    console.log(`${key} [${result.type}] -> ${status}`);
  }
}

function printSummary(summary) {
  console.log(
    `Healthy: ${summary.healthy}, Missing: ${summary.missing}, Unknown: ${summary.unknown}`
  );
}

function listPendingTypes(results) {
  const types = new Set();
  for (const result of results) {
    if (result.observation.status !== "healthy") {
      types.add(result.type);
    }
  }
  return Array.from(types.values()).sort();
}

function formatResultJson(result) {
  return {
    service: result.serviceName,
    state: result.stateId,
    type: result.type,
    status: result.observation.status,
    evidence: result.observation.evidence,
  };
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

module.exports = { run };
