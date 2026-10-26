import { WalletError, type Step, type WalletExecutor } from "./types";

/** Sends each step kind to the executor that knows how to run it. */
export function routeExecutors(byKind: Partial<Record<Step["kind"], WalletExecutor>>): WalletExecutor {
  return {
    async execute(step) {
      const executor = byKind[step.kind];
      if (!executor) throw new WalletError("failed", `This wallet can't run a "${step.kind}" step.`);
      return executor.execute(step);
    },
  };
}
