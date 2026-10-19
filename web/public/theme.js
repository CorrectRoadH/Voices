// Apply the browser preference before the first paint; keep this external for the server CSP.
(() => {
  let theme = "system";
  try {
    const stored = localStorage.getItem("voices.theme");
    if (stored === "light" || stored === "dark") theme = stored;
  } catch {}
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = dark ? "#171b24" : "#f6f7f9";
})();
