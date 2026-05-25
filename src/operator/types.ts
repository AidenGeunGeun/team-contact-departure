export type OperatorSessionPhase =
  | "idle"
  | "starting"
  | "running"
  | "completed"
  | "failed";

export type OperatorEventType =
  | "session_started"
  | "session_ready"
  | "session_failed"
  | "session_completed"
  | "user_prompt"
  | "assistant_text_start"
  | "assistant_text_delta"
  | "assistant_text_end"
  | "thinking_status"
  | "thinking_delta"
  | "thinking_end"
  | "tool_started"
  | "tool_updated"
  | "tool_completed"
  | "tool_failed"
  | "contact_cli"
  | "evidence_job_updated"
  | "transcript_written"
  | "follow_up_queued"
  | "session_aborted";

export interface OperatorEvent {
  id: string;
  session_id: string;
  timestamp: string;
  type: OperatorEventType;
  payload: Record<string, unknown>;
}

export interface OperatorSessionState {
  session_id: string | null;
  phase: OperatorSessionPhase;
  prompt?: string;
  run_id?: string;
  run_dir?: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
  auth_recovery?: string;
  model_fallback_message?: string;
  active_job_ids: string[];
  selected_job_id?: string;
  follow_up_count?: number;
}

export type ContactCliOperation =
  | "cases"
  | "show"
  | "run"
  | "watch"
  | "job"
  | "jobs"
  | "cancel"
  | "pair"
  | "bundle"
  | "unknown";

export interface ContactCliSummary {
  operation: ContactCliOperation;
  title: string;
  detail?: string;
  job_id?: string;
  case_id?: string;
}
