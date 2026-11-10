/**
 * Stale-server guard: the server's latest call trailing the transcript's last planner step for
 * `limit` consecutive checks means the server is stale for this Conversation.
 */
export class StaleGuard {
  private count = 0;
  constructor(private limit = 2) {}

  /** Returns true when the server must be treated as stale. */
  check(serverLastStep: number | null, transcriptLastPlannerStep: number | null): boolean {
    const trails = transcriptLastPlannerStep !== null && (serverLastStep === null || serverLastStep < transcriptLastPlannerStep);
    if (!trails) { this.count = 0; return false; }
    this.count += 1;
    return this.count >= this.limit;
  }

  reset(): void { this.count = 0; }
}
