// @concord-file
// @concord-implements docs/feature/appearance/README.md
// @concord-implements docs/feature/appearance/use-case/change-theme.md
import { tr } from "@/lib/i18n";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

type Theme = "system" | "light" | "dark";
const normalize = (value: string | null | undefined): Theme =>
  value === "light" || value === "dark" ? value : "system";
const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void }>({
  theme: "system",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() =>
    normalize(document.documentElement.dataset.theme),
  );
  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      const root = document.documentElement;
      root.dataset.theme = theme;
      root.classList.toggle("dark", dark);
      root.style.colorScheme = dark ? "dark" : "light";
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", dark ? "#171b24" : "#f6f7f9");
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
      if (event.key === "voices.theme" || event.key === null) {
        setTheme(normalize(event.newValue));
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const choose = (next: Theme) => {
    setTheme(next);
    try {
      localStorage.setItem("voices.theme", next);
    } catch {
      /* Keep this page usable without storage. */
    }
  };
  return (
    <ThemeContext.Provider value={{ theme, setTheme: choose }}>{children}</ThemeContext.Provider>
  );
}

export function ThemeSelect({ id }: { id?: string }) {
  const { theme, setTheme } = useContext(ThemeContext);
  return (
    <NativeSelect
      id={id}
      aria-label={tr("界面主题")}
      value={theme}
      onChange={(event) => setTheme(normalize(event.target.value))}
    >
      <NativeSelectOption value="system">{tr("跟随系统")}</NativeSelectOption>
      <NativeSelectOption value="light">{tr("浅色模式")}</NativeSelectOption>
      <NativeSelectOption value="dark">{tr("深色模式")}</NativeSelectOption>
    </NativeSelect>
  );
}
