// Detached background execution for the `workflow` tool (Plan #3 Task 3.4).
//
// External plugins cannot touch the core detached-task lifecycle
// (`createRunningTaskRun`/`completeTaskRunByRunId` — trust-gated/core-internal,
// api-findings.md §9.1). The sanctioned plugin-facing substitute is:
//   1. `api.runtime.tasks.managedFlows` for durable flow state (the result is
//      persisted into the flow's `stateJson`), and
//   2. `api.session.workflow.scheduleSessionTurn` for the deferred wakeup turn.
// Shapes below are adjusted to the EXACT signatures pinned in api-findings.md
// §10 (verified against openclaw source + the 2026.6.1 d.ts), NOT the plan's
// placeholder `{ create, setState }` / `{ sessionKey, reason }` skeleton.
//
// §10.1: a flow is created via `managedFlows.createManaged({ controllerId, goal,
//   stateJson })`, returning a `ManagedTaskFlowRecord` keyed by `flowId` with an
//   optimistic-concurrency `revision`. There is NO bare `setState`; writes go
//   through revision-checked mutators (`finish`/`fail`) that take
//   `{ flowId, expectedRevision, stateJson }` and return a discriminated
//   `ManagedTaskFlowMutationResult` (`{ applied:true; flow } | { applied:false;
//   code; current? }`).
// §10.2: `scheduleSessionTurn` is a 3-arm union; a one-shot resume wakeup uses
//   arm B `{ delayMs }` with `{ sessionKey, message, deliveryMode?,
//   deleteAfterRun? }`, and returns `PluginSessionSchedulerJobHandle | undefined`
//   (it is bundled-gated, so the handle is best-effort — may be `undefined`).
// §10.3: the tool returns `details:{ async:true, status:"started", taskId, ... }`
//   immediately; here we surface the managedFlow `flowId`.

/**
 * §10.1: `JsonValue` (from `task-flow-registry.types.ts:6-12`) — the durable
 * `stateJson`/`waitJson` slot type. Defined locally to mirror the source shape
 * without importing the trust-gated runtime internals.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** §10.1: durable JSON persisted in the flow's `stateJson` slot. */
export type DetachedFlowState =
  | { status: "running" }
  | { status: "done"; result: JsonValue }
  | { status: "failed"; error: string };

/** §10.1: `ManagedTaskFlowRecord` — host-assigned `flowId` + optimistic `revision`. */
export type ManagedFlowRecord = {
  flowId: string;
  revision: number;
};

/** §10.1: `ManagedTaskFlowMutationResult` — discriminated union returned by mutators. */
export type ManagedFlowMutationResult =
  | { applied: true; flow: ManagedFlowRecord }
  | {
      applied: false;
      code: "not_found" | "not_managed" | "revision_conflict" | "persist_failed";
      current?: ManagedFlowRecord;
    };

/**
 * §10.1: the session-bound `BoundTaskFlowRuntime` slice we use — `createManaged`
 * plus the two terminal mutators. The plugin reaches this via
 * `api.runtime.tasks.managedFlows.fromToolContext(ctx)`.
 */
export type ManagedFlows = {
  createManaged: (params: {
    controllerId: string;
    goal: string;
    stateJson?: JsonValue | null;
  }) => ManagedFlowRecord;
  finish: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
  }) => ManagedFlowMutationResult;
  fail: (params: {
    flowId: string;
    expectedRevision: number;
    stateJson?: JsonValue | null;
  }) => ManagedFlowMutationResult;
};

/**
 * §10.2: `scheduleSessionTurn` arm B (`delayMs`) for a one-shot wakeup. Returns a
 * job handle or `undefined` (bundled-gated; treat as best-effort).
 */
export type ScheduleSessionTurn = (params: {
  delayMs: number;
  sessionKey: string;
  message: string;
  deliveryMode?: "none" | "announce";
  deleteAfterRun?: boolean;
}) => Promise<{ id: string } | undefined>;

export type DetachedDeps = {
  managedFlows: ManagedFlows;
  scheduleSessionTurn: ScheduleSessionTurn;
  sessionKey: string;
  run: () => Promise<JsonValue>;
};

/** §10.3 "background started" return: surfaces the managedFlow `flowId` as `taskId`. */
export type DetachedStarted = { status: "started"; flowId: string };

export async function runDetached(deps: DetachedDeps): Promise<DetachedStarted> {
  // §10.1: create the managed flow up front so the tool can return its id now.
  const flow = deps.managedFlows.createManaged({
    controllerId: "workflows",
    goal: "Run detached workflow",
    stateJson: { status: "running" },
  });

  // Fire-and-forget the engine; deliver completion via the flow's `stateJson`
  // (revision-checked) + a scheduled wakeup turn carrying a resume message.
  void (async () => {
    try {
      const result = await deps.run();
      deps.managedFlows.finish({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        stateJson: { status: "done", result },
      });
    } catch (err) {
      deps.managedFlows.fail({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        stateJson: {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    // §10.2: arm B one-shot wakeup. `message` IS the resume signal injected into
    // the session turn; the handle is best-effort (may be `undefined`).
    await deps.scheduleSessionTurn({
      delayMs: 0,
      sessionKey: deps.sessionKey,
      message: `workflow ${flow.flowId} finished`,
      deliveryMode: "announce",
      deleteAfterRun: true,
    });
  })();

  return { status: "started", flowId: flow.flowId };
}
