export type AutomationType =
  | "workflow_automation"
  | "agent_assistant"
  | "data_validation"
  | "intake_form"
  | "system_integration"
  | "exception_monitoring"
  | "report_generation"
  | "approval_routing"
  | "knowledge_base";

export type ROIAssumptions = {
  annual_volume: number;
  minutes_saved_per_case: number;
  loaded_hourly_cost: number;
  error_rate: number;
  cost_per_error: number;
  exception_rate: number;
  delay_cost: number;
  confidence: number; // 0-1
  effort_penalty: number; // >= 1
};

export type Opportunity = {
  id: string;
  process_id: string;
  title: string;
  problem: string;
  proposed_solution: string;
  implementation_plan: string;
  expected_result: string;
  automation_type: AutomationType;
  pattern_id: string;
  pattern_label: string;
  assumptions: ROIAssumptions;
  // computed
  annual_time_value?: number;
  annual_error_value?: number;
  annual_delay_value?: number;
  gross_value?: number;
  net_score?: number;
  integration_requirements: string[];
  dependencies: string[];
  claim_ids: string[];
};

export type Insight = {
  id: string;
  process_id: string;
  title: string;
  issue: string;
  recommendation: string;
  claim_ids: string[];
  confidence: number;
};

export type Risk = {
  id: string;
  process_id: string;
  risk_type: "scenario" | "structural" | "compliance";
  title: string;
  body: string;
  severity: "high" | "med" | "low";
  likelihood: "high" | "med" | "low";
  business_impact: string;
  mitigation?: string;
  claim_ids: string[];
};
