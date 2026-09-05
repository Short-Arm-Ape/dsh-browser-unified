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
/** The five read-only tools upstream ships for the intranet instance. */
export const INTRANET_READ_ONLY_TOOLS = new Set([
    'intranet_snapshot',
    'intranet_screenshot',
    'intranet_scroll',
    'intranet_wait',
    'intranet_list_tabs',
]);
/** Decide what the gate should do for one tool call. Order is deliberate. */
export function gateAction(toolName, config, isArmed, policy = 'ask', shape = { prefix: 'intranet_' }) {
    const armTool = shape.armTool ?? `${shape.prefix}arm`;
    const disarmTool = shape.disarmTool ?? `${shape.prefix}disarm`;
    if (!toolName.startsWith(shape.prefix))
        return { kind: 'pass' }; // ① not ours
    if (toolName === disarmTool)
        return { kind: 'disarm' }; // ② disarm needs no approval
    if (policy === 'never')
        return { kind: 'pass' }; // ③ full-access session auto-passes
    if (toolName === armTool) {
        // Arming means something only under approvalMode 'arm'; under 'per-call'
        // it is a documented no-op and must not trigger a pointless prompt.
        return config.approvalMode === 'arm' ? { kind: 'ask-arm' } : { kind: 'pass' };
    }
    const readOnly = shape.readOnlyTools ?? INTRANET_READ_ONLY_TOOLS;
    if (config.approvalScope === 'navigation' && readOnly.has(toolName))
        return { kind: 'pass' };
    if (config.approvalMode === 'arm' && isArmed)
        return { kind: 'pass' };
    return { kind: 'ask' }; // ⑦ default
}
/**
 * Read the last `approval/policy` event from an agent session log (duck-typed,
 * mirrors the host fold without importing dsh types). `ask` when unknown.
 */
export function latestSessionPolicy(agent, fallback = 'ask') {
    const events = agent?.session?.events;
    if (events) {
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event?.type === 'approval/policy') {
                const policy = event.data?.policy;
                if (policy === 'ask' || policy === 'never')
                    return policy;
            }
        }
    }
    return fallback;
}
/** Human-readable reason shown on the approval prompt / denial, incl. URL when present. */
export function approvalReason(toolName, args, shape = { prefix: 'intranet_' }) {
    const gated = toolName === `${shape.prefix}open` || toolName === `${shape.prefix}open_tab`;
    if (gated) {
        const url = typeof args === 'object' && args !== null ? args.url : undefined;
        if (typeof url === 'string' && url) {
            return `Allow ${shape.prefix === 'intranet_' ? 'intranet/local' : 'browser'} access to ${url}?`;
        }
    }
    return `Allow ${shape.prefix === 'intranet_' ? 'intranet/local' : 'browser'} action (${toolName})?`;
}
