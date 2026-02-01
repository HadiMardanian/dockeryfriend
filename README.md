Role: Principal Software Architect and DX Lead

This document reframes the dev environment as a local control plane with a
strictly declarative manifest, an idempotent state engine, and cross-service
intelligence. It explicitly avoids "shell-scripting-in-YAML" and focuses on
desired state.

------------------------------------------------------------------------------

## The Core Idea (YAML Example)

```yaml
version: 1
project: nexus-demo

intents:
  onboarding:
    scope:
      packages: ["apps/*", "services/*"]
    desired:
      services:
        merchant-api:
          states: [deps.synchronized, schema.aligned, env.exported, service.running]
        frontend:
          states: [deps.synchronized, env.inherited, service.running]

  feature:
    scope:
      packages: ["apps/frontend", "services/merchant-api"]
    desired:
      services:
        merchant-api:
          states: [deps.synchronized, schema.aligned, env.exported, service.running]
        frontend:
          states: [deps.synchronized, env.inherited, service.running]

services:
  merchant-api:
    root: services/merchant-api
    type: node.service
    provides:
      env:
        MERCHANT_API_URL:
          valueFrom: service.endpoint
    states:
      deps.synchronized:
        type: package.deps
        manager: pnpm
        lockfile: pnpm-lock.yaml
      schema.aligned:
        type: db.schema
        provider: postgres
        source: prisma/schema.prisma
        target: database:merchant
      env.exported:
        type: env.export
        keys: [MERCHANT_API_URL]
      service.running:
        type: process.http
        port: 4001
        health: /health

  frontend:
    root: apps/frontend
    type: node.web
    requires:
      services: [merchant-api]
      states:
        merchant-api: [schema.aligned, env.exported]
    consumes:
      env:
        MERCHANT_API_URL:
          from: merchant-api.MERCHANT_API_URL
    states:
      deps.synchronized:
        type: package.deps
        manager: pnpm
        lockfile: pnpm-lock.yaml
      env.inherited:
        type: env.inherit
        from: merchant-api
      service.running:
        type: process.http
        port: 3000
        health: /

context:
  static:
    configHash: true
  dynamic:
    shell: inherit
    envAllowlist: [NODE_ENV, AWS_PROFILE]
```

------------------------------------------------------------------------------

## The Brainstorming Log

### Problem Definition
- Developers repeatedly run setup steps even when no changes occurred.
- Local environments drift away from the intended project baseline.
- Service interdependencies (env vars, schema state, ports) are implicit and
  fragile.
- The team needs deterministic, low-friction onboarding and day-to-day flow.

### Persona Analysis
- New hire onboarding: wants a single, safe "up" command that is repeatable.
- Feature developer: wants only relevant services and fast incremental updates.
- Incident responder: needs a production-like snapshot without guesswork.
- Lead architect: wants a declarative contract that is easy to evolve.

### Risk Assessment
- False positives in state detection can trigger unnecessary work.
- Secret leakage if env providers are not treated as sensitive outputs.
- Plugin quality variance can degrade trust in the control plane.
- Monorepo scale can overwhelm naive dependency resolution.

------------------------------------------------------------------------------

## 1. State & Idempotency Audit

### The Idempotency Problem
Running "setup" on every invocation creates waste and risk. Nexus must answer:
"Is the desired state already true?" using evidence, not flags.

### Local State Manifest (Local, Tech-Agnostic)
Nexus records the last known good state and evidence in a local manifest:

```json
{
  "manifestHash": "sha256:1c9b...e8",
  "observations": {
    "services/merchant-api:deps.synchronized": {
      "status": "healthy",
      "evidence": {
        "lockfile": "sha256:77aa...12",
        "packageManager": "pnpm@9.1.0",
        "node": "20.11.0"
      },
      "lastValidatedAt": "2026-02-01T12:10:05Z",
      "lastAppliedAt": "2026-02-01T12:09:42Z"
    },
    "services/merchant-api:schema.aligned": {
      "status": "healthy",
      "evidence": {
        "schemaChecksum": "sha256:ad04...33",
        "migrationHead": "20260201_1200_add_orders"
      },
      "lastValidatedAt": "2026-02-01T12:10:07Z",
      "lastAppliedAt": "2026-02-01T12:09:50Z"
    }
  }
}
```

Key properties:
- Stored in `.nexus/state.json` (local, gitignored).
- Technology-agnostic evidence produced by plugins (not hard-coded in core).
- Tied to `manifestHash`. If the manifest changes, the state is revalidated.
- Supports partial invalidation when only some state descriptors change.

------------------------------------------------------------------------------

## 2. Mental Model: Desired State vs Command Execution

### State-First Thinking
- "npm install" becomes `deps.synchronized`.
- "prisma migrate" becomes `schema.aligned`.
- "export env" becomes `env.exported`.

The YAML declares *what* is desired. Plugins decide *how* to reach it.

### Static Config vs Dynamic Context
- **Static Config**: `nexus.yaml` in the repo, versioned, audited.
- **Dynamic Context**: shell env, OS, runtime secrets, and local overrides.

Resolution precedence (no scripting, only data):
1. Manifest defaults
2. Team policy (repo)
3. Local overrides (safe, gitignored)
4. Shell env (allowlisted)

------------------------------------------------------------------------------

## 3. Cross-Service Intelligence (Dependency Graph)

### Dependency Graph
Services declare dependencies via `requires` and `consumes`. The graph is
derived, not manually defined.

```
merchant-api (schema.aligned, env.exported)
    | provides MERCHANT_API_URL
    v
frontend (env.inherited, service.running)
```

### Provider / Consumer Model (Env Flow)
- Providers export named values (endpoints, ports, tokens).
- Consumers explicitly bind to provider outputs.
- Secrets do not appear in the manifest; they are resolved by plugins or the
  environment provider at runtime.

This allows readiness gates: frontend "ready" is blocked until merchant-api
states are healthy and its env outputs are available.

------------------------------------------------------------------------------

## 4. The "Day 2" Evolution

### Monorepos (pnpm workspace with 20 packages)
- Manifest supports `packages` selectors and workspace-aware dependency graph.
- Nexus resolves per-intent scope to avoid starting the entire workspace.
- State caching is scoped by package path + lockfile hash.

### Team Synchronization
- `manifestHash` is stored in `.nexus/state.json`.
- On `nexus sync`, mismatched hashes trigger revalidation and selective updates.
- Manifest updates are pulled via git; Nexus treats changes as new desired state.

### Escape Hatches (Safe Override)
Local overrides are allowed but tightly scoped and non-scriptable.

```yaml
# .nexus/overrides.yaml (gitignored)
overrides:
  intents:
    feature:
      services:
        frontend:
          states:
            service.running:
              desired: false
  env:
    add:
      LOCAL_MOCK_SERVER: "http://localhost:7777"
```

Constraints:
- No new state types.
- No arbitrary commands.
- Changes are local, explicit, and inspectable.

------------------------------------------------------------------------------

## 5. The Nexus Manifest Spec (Strictly Declarative)

```yaml
version: integer
project: string
intents:
  <intent-name>:
    scope:
      packages: [selector...]
    desired:
      services:
        <service-name>:
          states: [state-id...]
services:
  <service-name>:
    root: string
    type: string
    requires:
      services: [service-name...]
      states:
        <service-name>: [state-id...]
    provides:
      env:
        <VAR_NAME>:
          valueFrom: string
    consumes:
      env:
        <VAR_NAME>:
          from: <service-name>.<VAR_NAME>
    states:
      <state-id>:
        type: <capability-id>
        ... plugin-defined properties ...
context:
  static:
    configHash: boolean
  dynamic:
    shell: inherit|deny
    envAllowlist: [VAR...]
policies:
  concurrency: integer
  secrets:
    allowlist: [VAR...]
plugins:
  - name: string
    version: string
state:
  store: .nexus/state.json
```

Notes:
- The manifest expresses desired states only.
- Capabilities are provided by plugins and are versioned independently.
- The dependency graph is derived from `requires` and `consumes`.

------------------------------------------------------------------------------

## 6. The Lifecycle Engine

```
Resolve -> Validate -> Execute -> Persist State
```

### Resolve
- Load manifest + dynamic context.
- Compute manifest hash.
- Build dependency graph and intent scope.

### Validate
- Ask each plugin to observe its state (non-mutating).
- Produce evidence and compare with desired state.

### Execute
- For any non-compliant states, invoke plugin reconcile.
- Enforce graph order and policies (concurrency, safety).

### Persist State
- Write updated evidence to `.nexus/state.json`.
- Record last known good state with timestamps.

This loop yields a deterministic diff between desired and observed state.

------------------------------------------------------------------------------

## 7. The Integration Pattern (Third-Party Plugins)

Plugins extend the control plane without polluting core logic.

### Plugin Contract
Each plugin registers one or more **capabilities**:
- `schema`: validation of desired config for the capability
- `observe(context) -> observation`
- `diff(desired, observation) -> delta`
- `reconcile(delta, context) -> effect`

Example: Prisma plugin
- Observation includes schema checksum and migration head.
- Reconcile uses the Prisma engine through a plugin adapter.

Distribution:
- `nexus plugin add prisma` installs a signed plugin that declares its
  capabilities and observation schema.

------------------------------------------------------------------------------

## 8. CLI UX Flow

Commands align with intent and state, not scripts.

- `nexus dev --intent feature` : resolve, validate, execute for dev loop
- `nexus sync --intent onboarding` : align local state to team baseline
- `nexus status` : show desired vs observed diff
- `nexus graph` : visualize dependency graph
- `nexus env --service frontend` : print resolved env bindings
- `nexus doctor` : diagnostics, plugin health, policy checks
- `nexus override edit` : manage safe local overrides

------------------------------------------------------------------------------

## Why This Extension Is Better

- **Eliminates scripting thinking**: everything is a state descriptor, not a
  command list.
- **Focuses on diffable state**: Nexus stores evidence and compares against
  desired outcomes.
- **Addresses interconnectivity**: dependencies and env flows are explicit.
- **Operationalizes DX**: intents capture onboarding, feature work, and
  incident response as first-class modes.

This design treats the dev environment as a system that converges on a
desired state rather than a series of imperative steps.