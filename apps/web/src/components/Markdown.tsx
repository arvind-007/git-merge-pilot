import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import { safeUrl } from '../lib/links.ts';

const components: Components = {
  a: ({ href, children }) => {
    const url = safeUrl(href);
    return url ? (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-indigo-700 underline dark:text-indigo-300"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  // Never load remote images from untrusted repo text (tracking pixels); show alt text instead.
  img: ({ alt }) => <span className="italic">[image{alt ? `: ${alt}` : ''}]</span>,
  h1: ({ children }) => <h3 className="mt-3 text-base font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 text-base font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 text-sm font-semibold">{children}</h4>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  p: ({ children }) => <p className="my-2 break-words">{children}</p>,
  code: ({ children }) => (
    <code className="rounded bg-slate-100 px-1 font-mono text-xs dark:bg-slate-800">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-slate-100 p-2 text-xs dark:bg-slate-950">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-4 border-slate-300 pl-3 text-slate-600 dark:border-slate-600 dark:text-slate-400">
      {children}
    </blockquote>
  ),
};

/**
 * Markdown renderer for untrusted repo/AI text. Raw HTML is skipped entirely (no rehype-raw),
 * URLs are restricted to http(s)/relative, and images are not loaded.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ?? 'text-sm text-slate-800 dark:text-slate-200'}>
      <ReactMarkdown
        skipHtml
        components={components}
        urlTransform={(url) => (safeUrl(defaultUrlTransform(url)) ? url : '')}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
