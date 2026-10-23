// Probe TLS/routing without sending credentials or invoking a paid model.
const names = ["E2E_MODEL_BASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"];
try {
  const urls = [...new Set(names.map((name) => process.env[name]).filter(Boolean))];
  if (!urls.length) throw new Error();
  for (const base of urls) {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
    let reachable = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
        await response.body?.cancel();
        if ([200, 401, 403].includes(response.status)) { reachable = true; break; }
      } catch { /* Never print a URL-bearing transport error. */ }
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!reachable) throw new Error();
  }
  console.log("Model endpoint TLS/routing checks passed (no inference requested).");
} catch {
  console.error("Model endpoint connectivity failed; raw network diagnostics suppressed.");
  process.exitCode = 1;
}
