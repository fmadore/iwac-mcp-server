import type { Action, ViewContext } from "./shell.js";

/** Keep action state independent from whether an operation replaces the view. */
export function wireActions(root: HTMLElement, actions: Action[], ctx: ViewContext): void {
  for (const action of actions) {
    const button = root.querySelector<HTMLButtonElement>(`#act-${action.id}`);
    button?.addEventListener("click", async () => {
      if (button.disabled) return;
      const label = button.textContent;
      button.disabled = true;
      button.textContent = action.busyLabel ?? "Loading…";
      root.querySelector(".action-error")?.remove();
      try {
        await action.run(ctx);
      } catch (error) {
        if (button.isConnected) {
          const status = document.createElement("p");
          status.className = "action-error warn";
          status.setAttribute("role", "alert");
          status.textContent = `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
          button.parentElement?.after(status);
        }
      } finally {
        // Downloads and opening a source succeed without a navigation. Only
        // restore the original element: a new view owns its own action state.
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = label;
        }
      }
    });
  }
}

/** Invalidating a request also clears the persistent root's busy attribute. */
export class ViewRequests {
  private generation = 0;
  private busy = false;
  constructor(private readonly root: HTMLElement) {}
  begin(): number {
    this.busy = true;
    this.sync();
    return ++this.generation;
  }
  isCurrent(ticket: number): boolean {
    return ticket === this.generation;
  }
  invalidate(): void {
    this.generation++;
    this.busy = false;
    this.sync();
  }
  finish(ticket: number): void {
    if (this.isCurrent(ticket)) {
      this.busy = false;
      this.sync();
    }
  }
  sync(): void {
    if (!this.busy) {
      this.root.removeAttribute("aria-busy");
      this.root.querySelector(".loading")?.remove();
      return;
    }
    this.root.setAttribute("aria-busy", "true");
    if (!this.root.querySelector(".loading")) {
      const status = document.createElement("p");
      status.className = "loading";
      status.setAttribute("role", "status");
      status.textContent = "Loading…";
      this.root.append(status);
    }
  }
}
