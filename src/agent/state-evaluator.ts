import type { JsonValue } from "../types.js";
import type { AgentStep } from "./planner.js";

export interface AgentStepResult {
  ok: boolean;
  done: boolean;
  output: string;
  code?: number | null;
  error_type?: string;
  observation: JsonValue;
}

export interface StateEvaluation {
  decision: "continue" | "final" | "stop";
  reason: string;
  metrics: {
    steps: number;
    errors: number;
    repeated_actions: number;
    artifacts: number;
  };
}

export interface StateEvaluationInput {
  step: number;
  plan: AgentStep;
  result: AgentStepResult;
  observations: JsonValue[];
}

export function evaluateAgentState(input: StateEvaluationInput): StateEvaluation {
  const metrics = collectMetrics(input);
  if (input.result.done) {
    return {
      decision: "final",
      reason: input.plan.kind === "answer" || input.plan.kind === "final"
        ? "planner produced a final response"
        : "step completed the goal",
      metrics
    };
  }
  if (!input.result.ok) {
    return {
      decision: "continue",
      reason: "step failed but repair or another planner step may still recover",
      metrics
    };
  }
  if (metrics.repeated_actions >= 2) {
    return {
      decision: "stop",
      reason: "planner repeated the same action too many times",
      metrics
    };
  }
  return {
    decision: "continue",
    reason: "step produced an observation for the next planner step",
    metrics
  };
}

function collectMetrics(input: StateEvaluationInput): StateEvaluation["metrics"] {
  return {
    steps: input.step + 1,
    errors: input.observations.filter(hasErrorObservation).length + (input.result.ok ? 0 : 1),
    repeated_actions: countRepeatedActions(input.plan, input.observations),
    artifacts: input.observations.filter(hasArtifactObservation).length + (hasArtifactObservation(input.result.observation) ? 1 : 0)
  };
}

function countRepeatedActions(plan: AgentStep, observations: JsonValue[]) {
  const current = stableActionKey(plan);
  return observations.filter((observation) => {
    if (!isRecord(observation) || !isRecord(observation.action)) {
      return false;
    }
    return stableActionKey(observation.action) === current;
  }).length;
}

function stableActionKey(value: unknown) {
  if (!isRecord(value)) {
    return JSON.stringify(value);
  }
  return JSON.stringify({
    kind: value.kind,
    tool: value.tool,
    task: value.task,
    action: isRecord(value.request) ? value.request.action : undefined
  });
}

function hasErrorObservation(value: JsonValue): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === false || value.error_type || value.error) {
    return true;
  }
  return Object.values(value).some((item) => isJsonValue(item) && hasErrorObservation(item));
}

function hasArtifactObservation(value: JsonValue): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.output === "string" || typeof value.file === "string" || typeof value.run === "string") {
    return true;
  }
  if (isRecord(value.result) && (typeof value.result.output === "string" || typeof value.result.file === "string")) {
    return true;
  }
  return Object.values(value).some((item) => isJsonValue(item) && hasArtifactObservation(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || Array.isArray(value)
    || isRecord(value);
}
