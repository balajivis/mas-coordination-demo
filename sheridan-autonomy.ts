/**
 * Sheridan's Levels of Automation (1978) adapted for AI Agent Systems
 *
 * Original: Sheridan & Verplank's 10 levels of automation for human-computer
 * decision-making, mapping from "human does everything" to "computer is fully autonomous."
 *
 * This framework maps each level to concrete HITL patterns for multi-agent systems.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutonomyLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface SheridanLevel {
  level: AutonomyLevel;
  name: string;
  description: string;
  agentBehavior: string;
  humanRole: string;
  hitlPattern: HitlPattern;
  /** When to use this level */
  useCases: string[];
  /** Risk tolerance: low = more human oversight */
  riskTolerance: "none" | "very-low" | "low" | "moderate" | "high" | "full";
}

export type HitlPattern =
  | "human-only"
  | "agent-suggests"
  | "agent-recommends"
  | "agent-plans-human-approves"
  | "agent-acts-human-confirms"
  | "agent-acts-human-can-veto"
  | "agent-acts-reports-after"
  | "agent-acts-reports-on-exception"
  | "agent-acts-reports-if-asked"
  | "full-autonomy";

export interface AgentAutonomyConfig {
  agentName: string;
  defaultLevel: AutonomyLevel;
  /** Override levels per action category */
  overrides: ActionOverride[];
}

export interface ActionOverride {
  action: string;
  level: AutonomyLevel;
  reason: string;
}

// ---------------------------------------------------------------------------
// The 10 Levels
// ---------------------------------------------------------------------------

export const SHERIDAN_LEVELS: readonly SheridanLevel[] = [
  {
    level: 1,
    name: "Manual",
    description: "Human does everything; agent offers no assistance.",
    agentBehavior: "Agent is passive. No suggestions, no actions.",
    humanRole: "Full decision-making and execution.",
    hitlPattern: "human-only",
    useCases: [
      "Training scenarios where human must learn",
      "Extremely high-stakes irreversible decisions",
      "Regulatory requirements for human-only execution",
    ],
    riskTolerance: "none",
  },
  {
    level: 2,
    name: "Offer Alternatives",
    description: "Agent offers a complete set of alternatives for human to choose from.",
    agentBehavior: "Agent researches and presents ALL options. No ranking, no recommendation.",
    humanRole: "Evaluates options, selects one, executes.",
    hitlPattern: "agent-suggests",
    useCases: [
      "Exploratory research where human needs full context",
      "Decisions with multiple valid approaches",
      "Early-stage planning before direction is set",
    ],
    riskTolerance: "very-low",
  },
  {
    level: 3,
    name: "Narrow Alternatives",
    description: "Agent narrows options to a shortlist and suggests one.",
    agentBehavior: "Agent filters, ranks, and recommends a preferred option with rationale.",
    humanRole: "Reviews recommendation, accepts or overrides, executes.",
    hitlPattern: "agent-recommends",
    useCases: [
      "Architecture decisions",
      "Dependency selection",
      "Choosing between migration strategies",
    ],
    riskTolerance: "very-low",
  },
  {
    level: 4,
    name: "Suggest Action",
    description: "Agent suggests a complete action plan and waits for explicit approval.",
    agentBehavior: "Agent drafts full plan (code, commands, etc.) but does NOT execute. Waits for human 'go ahead'.",
    humanRole: "Reviews plan, may modify, gives explicit approval before execution.",
    hitlPattern: "agent-plans-human-approves",
    useCases: [
      "Database migrations",
      "Infrastructure changes",
      "Deploying to production",
      "Modifying shared code",
    ],
    riskTolerance: "low",
  },
  {
    level: 5,
    name: "Execute if Approved",
    description: "Agent executes the plan automatically UNLESS human vetoes within a time window.",
    agentBehavior: "Agent presents plan, starts a countdown. Executes if no objection.",
    humanRole: "Has a window to review and veto. Silence = consent.",
    hitlPattern: "agent-acts-human-confirms",
    useCases: [
      "Routine deployments with rollback",
      "PR merges after CI passes",
      "Scheduled maintenance tasks",
    ],
    riskTolerance: "moderate",
  },
  {
    level: 6,
    name: "Execute, Allow Veto",
    description: "Agent executes immediately but human can override/rollback at any time.",
    agentBehavior: "Agent acts immediately. Sends notification. Human can undo.",
    humanRole: "Monitors notifications, intervenes only if something looks wrong.",
    hitlPattern: "agent-acts-human-can-veto",
    useCases: [
      "Code formatting / linting fixes",
      "Non-breaking refactors with tests",
      "Auto-responding to routine alerts",
    ],
    riskTolerance: "moderate",
  },
  {
    level: 7,
    name: "Execute and Report",
    description: "Agent executes and reports what it did after the fact.",
    agentBehavior: "Agent acts autonomously, then provides a summary/log of actions taken.",
    humanRole: "Reviews summaries periodically. No real-time monitoring.",
    hitlPattern: "agent-acts-reports-after",
    useCases: [
      "Running test suites",
      "Generating reports",
      "Updating documentation",
      "Log analysis",
    ],
    riskTolerance: "high",
  },
  {
    level: 8,
    name: "Execute, Report on Exception",
    description: "Agent executes and only reports if something unusual happens.",
    agentBehavior: "Agent acts silently. Only surfaces exceptions, errors, or anomalies.",
    humanRole: "Only engaged when agent encounters something outside normal parameters.",
    hitlPattern: "agent-acts-reports-on-exception",
    useCases: [
      "Health checks and monitoring",
      "Retry logic for transient failures",
      "Routine data pipelines",
    ],
    riskTolerance: "high",
  },
  {
    level: 9,
    name: "Execute, Report if Asked",
    description: "Agent executes freely. Reports only when human explicitly requests status.",
    agentBehavior: "Agent operates independently. Logs exist but aren't pushed to human.",
    humanRole: "Pulls status on demand. Trusts agent to operate correctly.",
    hitlPattern: "agent-acts-reports-if-asked",
    useCases: [
      "Background indexing",
      "Cache warming",
      "Non-critical periodic tasks",
    ],
    riskTolerance: "full",
  },
  {
    level: 10,
    name: "Full Autonomy",
    description: "Agent decides everything, acts, and may not even be capable of reporting.",
    agentBehavior: "Fully autonomous. No human interface required.",
    humanRole: "None. Human may not even be aware the agent is operating.",
    hitlPattern: "full-autonomy",
    useCases: [
      "Garbage collection",
      "Auto-scaling within pre-set bounds",
      "Heartbeat/keepalive systems",
    ],
    riskTolerance: "full",
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the Sheridan level definition */
export function getLevel(level: AutonomyLevel): SheridanLevel {
  return SHERIDAN_LEVELS[level - 1];
}

/** Determine if human approval is needed before agent acts */
export function requiresApproval(level: AutonomyLevel): boolean {
  return level <= 4;
}

/** Determine if human is notified after agent acts */
export function notifiesHuman(level: AutonomyLevel): boolean {
  return level <= 8;
}

/** Resolve the effective autonomy level for an agent + action */
export function resolveLevel(
  config: AgentAutonomyConfig,
  action: string,
): AutonomyLevel {
  const override = config.overrides.find((o) => o.action === action);
  return override ? override.level : config.defaultLevel;
}

// ---------------------------------------------------------------------------
// Example agent configurations for the MAS blackboard system
// ---------------------------------------------------------------------------

export const EXAMPLE_CONFIGS: AgentAutonomyConfig[] = [
  {
    agentName: "researcher",
    defaultLevel: 7, // Act and report — research is low-risk
    overrides: [
      { action: "write-file", level: 4, reason: "File writes need approval" },
      { action: "web-fetch", level: 7, reason: "Reading external sources is fine" },
    ],
  },
  {
    agentName: "developer",
    defaultLevel: 4, // Plan and wait for approval — code changes matter
    overrides: [
      { action: "read-file", level: 9, reason: "Reading is always safe" },
      { action: "run-tests", level: 7, reason: "Tests are non-destructive" },
      { action: "edit-file", level: 4, reason: "Code changes need review" },
      { action: "git-push", level: 4, reason: "Pushing needs explicit approval" },
      { action: "deploy", level: 5, reason: "Deploy with veto window" },
    ],
  },
  {
    agentName: "reviewer",
    defaultLevel: 6, // Act with veto — reviews are advisory
    overrides: [
      { action: "approve-pr", level: 4, reason: "PR approval needs human sign-off" },
      { action: "comment-pr", level: 7, reason: "Comments are low-risk" },
    ],
  },
];
