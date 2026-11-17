// Only the external Analytics Engine boundary is replaced. The real handler and monitor run unchanged.
import worker, { type Env } from "../src/index.ts";
export default {
  fetch(request: Request, env: Env & { FAIL_ANALYTICS?: boolean }, ctx: ExecutionContext) {
    return worker.fetch(
      request,
      {
        ...env,
        UPDATE_REQUESTS: {
          writeDataPoint() {
            if (env.FAIL_ANALYTICS) throw new Error("PRIVATE_SENTINEL_analytics");
          },
        } as AnalyticsEngineDataset,
      },
      ctx,
    );
  },
};
