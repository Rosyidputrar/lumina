/**
 * A small Markdown renderer for analyst answers and vault notes.
 *
 * It builds React elements, never HTML strings, so text from the AI or another
 * user's note cannot inject markup. Supported: headings, paragraphs, bullet and
 * numbered lists, **bold**, *italic*, `code`, [[wikilinks]] and http(s) links.
 */
import { Fragment, type ReactNode } from 'react';

function inline(text: string, onWikilink?: (target: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[\[[^\]]+\]\]|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `t${i++}`;
    if (tok.startsWith('**')) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('[[')) {
      const inner = tok.slice(2, -2);
      const [target, alias] = inner.split('|');
      out.push(
        onWikilink ? (
          <button key={key} type="button" className="wikilink" onClick={() => onWikilink(target.trim())}>
            {(alias ?? target).trim()}
          </button>
        ) : (
          <span key={key}>{(alias ?? target).trim()}</span>
        ),
      );
    } else if (tok.startsWith('[')) {
      const label = tok.slice(1, tok.indexOf(']('));
      out.push(
        <a key={key} className="link" href={m[2]} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    } else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, onWikilink, className = 'prose' }: { text: string; onWikilink?: (target: string) => void; className?: string }) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let k = 0;

  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${k++}`}>{inline(para.join(' '), onWikilink)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, onWikilink)}</li>);
    blocks.push(list.ordered ? <ol key={`l${k++}`}>{items}</ol> : <ul key={`l${k++}`}>{items}</ul>);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      const level = Math.min(4, h[1].length + 1);
      const Tag = `h${level}` as 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={`h${k++}`}>{inline(h[2], onWikilink)}</Tag>);
    } else if (ul || ol) {
      flushPara();
      const ordered = Boolean(ol);
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((ul ?? ol)![1]);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <div className={className}>{blocks.length ? blocks : <Fragment />}</div>;
}
