import type { AgentMessage } from './planners';

/**
 * The agents' own words, as people see them: plain text that names sources and reports by title.
 * Both prompts ask for that; this makes sure of it, whatever the model writes. Titles come only from
 * the run's own tool results, so a run can't surface a title it was never shown.
 */

/** Result fields that hold an id, and the field naming the same thing. */
const TITLED: Array<[idKey: string, titleKey: string]> = [
  ['id', 'title'],
  ['assetVersionId', 'title'],
  ['reportId', 'title'],
  ['artifactId', 'title'],
  ['blockedAssetVersionId', 'blockedTitle'],
];

/** Every id → title pair in the run's tool results. */
export function titlesFrom(history: AgentMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    for (const [idKey, titleKey] of TITLED) {
      const id = o[idKey];
      const title = o[titleKey];
      if (typeof id === 'string' && id && typeof title === 'string' && title.trim()) out.set(id, title.trim());
    }
    Object.values(o).forEach(walk);
  };
  for (const m of history) if (m.role === 'tool') m.results.forEach((r) => walk(r.response));
  return out;
}

/** Markdown as plain text: emphasis, headings, code and links lose their markup; bullets become "•". */
export function stripMarkdown(text: string): string {
  return (
    text
      .replace(/```[a-z]*\n?/gi, '')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, '$1')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1$2')
      // Underscores only as bold: ids are full of single ones.
      .replace(/(^|\s)__([^_\n]+)__(?=\s|[.,;:!?]|$)/g, '$1$2')
      .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
      .replace(/^[ \t]*(?:-{3,}|\*{3,})[ \t]*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** What a person reads: no markdown, and each known id replaced by its title (longest ids first). */
export function plainText(text: string, titles: Map<string, string>): string {
  let out = stripMarkdown(text);
  for (const id of [...titles.keys()].sort((a, b) => b.length - a.length)) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A quoted id loses its own quotes; a bare one gets them.
    const title = `“${titles.get(id)!}”`;
    out = out.replace(new RegExp(`["“']?(?<![\\w-])${escaped}(?![\\w-])["”']?`, 'g'), () => title);
  }
  // "Northwind Index (“Northwind Index”)": the model gave the title and the id together.
  return out.replace(/\s*\(“([^”]+)”\)/g, (match, title: string, at: number, whole: string) => (whole.slice(Math.max(0, at - title.length - 1), at).includes(title) ? '' : match));
}
