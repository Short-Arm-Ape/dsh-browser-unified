/**
 * dsh-browser-unified-mit — MIT-licensed release (contains no caob23-derived code).
 * Relicensed MIT by the repository authors; upstream (MIT) attribution of distilled
 * semantics is in NOTICE.md. License: MIT.
 */
/**
 * Approval-gate decision table — merge prototype.
 *
 * Distilled from `dsh-intranet-browser` (Short-Arm-Ape, MIT) src/gate.ts and
 * generalized: any tool prefix, any read-only tool set, any arm/disarm names.
 * The decision stays a pure function so it is unit-testable without a host.
 *
 * NOTE: this prototype models the *tool-level* gate only. The intranet
 * upstream documents that approval granularity (tool calls) does not cover
 * page-internal requests; any real provider must pair this gate with the
 * request-level blocklist from url-policy.ts.
 * @module dsh-browser-unified-mit/approval
 */
/** The calling session's approval policy (host fold), as modelled by upstream. */
export type ApprovalPolicy = 'ask' | 'never';
export interface GateConfig {
    /** per-call: every gated call asks. arm: one approved arm disables prompts. */
    approvalMode: 'per-call' | 'arm';
    /** all: every gated call asks. navigation: read-only calls run free. */
    approvalScope: 'all' | 'navigation';
}
export type GateAction = {
    kind: 'pass';
} | {
    kind: 'ask-arm';
} | {
    kind: 'ask';
} | {
    kind: 'disarm';
};
export interface GateShape {
    /** Tool-name prefix that marks this instance's tools (e.g. "intranet_"). */
    readonly prefix: string;
    /** Tools that cannot move the browser to a new origin; free under approvalScope:'navigation'. */
    readonly readOnlyTools?: ReadonlySet<string>;
    /** Name of the arm tool; default `<prefix>arm`. */
    readonly armTool?: string;
    /** Name of the disarm tool; default `<prefix>disarm`. */
    readonly disarmTool?: string;
}
/** The five read-only tools upstream ships for the intranet instance. */
export declare const INTRANET_READ_ONLY_TOOLS: ReadonlySet<string>;
/** Decide what the gate should do for one tool call. Order is deliberate. */
export declare function gateAction(toolName: string, config: GateConfig, isArmed: boolean, policy?: ApprovalPolicy, shape?: GateShape): GateAction;
/**
 * Read the last `approval/policy` event from an agent session log (duck-typed,
 * mirrors the host fold without importing dsh types). `ask` when unknown.
 */
export declare function latestSessionPolicy(agent: unknown, fallback?: ApprovalPolicy): ApprovalPolicy;
/** Human-readable reason shown on the approval prompt / denial, incl. URL when present. */
export declare function approvalReason(toolName: string, args: unknown, shape?: GateShape): string;
