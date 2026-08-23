/**
 * The step trace.
 * License: Apache-2.0
 *
 * Every network exchange the playground performs is recorded here as it
 * happens: what was sent, what came back, and how long it took. The Flow panel
 * renders it live and the Wire panel renders it afterwards, so what the visitor
 * is shown is the traffic that actually occurred rather than a description of
 * it written separately.
 */

export type StepState = "pending" | "running" | "ok" | "failed" | "skipped";

export interface Step {
  id: string;
  title: string;
  /** One sentence on what this step is for, shown under the title. */
  note: string;
  state: StepState;
  startedAt?: number;
  ms?: number;
  /** What was sent, when the step sent something. */
  request?: unknown;
  /** What came back. */
  response?: unknown;
  /** Set when the step failed. */
  error?: string;
  /** Short human summary rendered next to the step once it settles. */
  summary?: string;
}

export type TraceListener = (trace: Trace) => void;

export class Trace {
  readonly steps: Step[] = [];
  private listeners: TraceListener[] = [];

  /**
   * Registers a listener called on every change.
   *
   * @param listener - Called with this trace whenever a step changes
   * @returns A function that removes the listener
   */
  onChange(listener: TraceListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this);
  }

  /**
   * Declares the steps up front, so the visitor can see what is about to
   * happen rather than watching rows appear one at a time.
   *
   * @param steps - Step id, title and note for each planned step
   */
  plan(steps: Array<Pick<Step, "id" | "title" | "note">>): void {
    this.steps.length = 0;
    for (const step of steps) this.steps.push({ ...step, state: "pending" });
    this.emit();
  }

  /**
   * Finds a planned step.
   *
   * @param id - Step id
   * @returns The step
   * @throws {Error} When no step with that id was planned
   */
  private get(id: string): Step {
    const step = this.steps.find((entry) => entry.id === id);
    if (!step) throw new Error(`step '${id}' was never planned`);
    return step;
  }

  /**
   * Runs one planned step, recording timing, result and any failure.
   *
   * @param id - Step id
   * @param fn - The work; may record a request and must return a result
   * @returns Whatever the step returned
   * @throws {Error} Rethrows the step's failure after recording it
   */
  async run<T>(
    id: string,
    fn: (record: (patch: Partial<Step>) => void) => Promise<T>,
  ): Promise<T> {
    const step = this.get(id);
    step.state = "running";
    step.startedAt = performance.now();
    this.emit();

    const record = (patch: Partial<Step>) => {
      Object.assign(step, patch);
      this.emit();
    };

    try {
      const result = await fn(record);
      step.state = "ok";
      step.ms = Math.round(performance.now() - step.startedAt);
      this.emit();
      return result;
    } catch (error) {
      step.state = "failed";
      step.ms = Math.round(performance.now() - step.startedAt);
      step.error = error instanceof Error ? error.message : String(error);
      // Steps after a failure never ran; say so rather than leaving them
      // looking like they are still pending.
      let seen = false;
      for (const entry of this.steps) {
        if (entry.id === id) { seen = true; continue; }
        if (seen && entry.state === "pending") entry.state = "skipped";
      }
      this.emit();
      throw error;
    }
  }
}
