// @concord-file
// @concord-implements docs/feature/updates/use-case/check-updates.md
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function safeReleaseLink(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

// Parse Markdown, never remote HTML. Images are omitted to avoid remote requests.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 break-words text-sm leading-6 [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => safeReleaseLink(url) || ""}
        components={{
          h1: ({ children }) => <h2 className="text-xl font-semibold">{children}</h2>,
          h2: ({ children }) => <h3 className="text-lg font-semibold">{children}</h3>,
          h3: ({ children }) => <h4 className="font-semibold">{children}</h4>,
          ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
          pre: ({ children }) => (
            <pre className="max-w-full overflow-x-auto rounded-md bg-muted p-3">{children}</pre>
          ),
          code: ({ children }) => <code className="font-mono text-xs">{children}</code>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 pl-3 text-muted-foreground">{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="max-w-full overflow-x-auto">
              <table className="w-full text-left">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border-b px-2 py-1 font-medium">{children}</th>,
          td: ({ children }) => <td className="border-b px-2 py-1">{children}</td>,
          a: ({ href, children }) =>
            safeReleaseLink(href) ? (
              <a
                href={href}
                className="underline underline-offset-4"
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: () => null,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
