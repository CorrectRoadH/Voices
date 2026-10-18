// @concord-file
// @concord-implements docs/feature/updates/use-case/check-updates.md
export function recordUpdateRequest(
  binding: AnalyticsEngineDataset | undefined,
  params: URLSearchParams,
  request: Request,
): void {
  if (!binding) return;
  const instance = params.get("instanceId") ?? "";
  const version = params.get("version") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instance) ||
      !/^[A-Za-z0-9._+-]{1,64}$/.test(version)) return;
  const token = (name: string) => {
    const value = params.get(name) ?? "";
    return /^[A-Za-z0-9._+\/-]{1,32}$/.test(value) ? value : "";
  };
  const country = request.cf?.country;
  try {
    binding.writeDataPoint({
      indexes: [instance.toLowerCase()],
      blobs: [version, token("goVersion"), token("os"), token("arch"), token("locale"),
        typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : "ZZ"],
      doubles: [],
    });
  } catch {
    // Never log request parameters or interrupt update delivery.
    console.warn("voices update analytics write failed");
  }
}
