import type { ReactNode } from 'react';

/**
 * The assistant's prose.
 *
 * A deliberately tiny renderer rather than a markdown library. The model reaches
 * for bold, bullets and the occasional inline code span and nothing else, so
 * those three are supported and everything else renders as the literal text the
 * model wrote. Nothing here interprets HTML, so model output cannot inject
 * markup into the page.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={key} className="mono">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

/** A line that is only bold text reads as a heading, because that is what it is. */
const STANDALONE_BOLD = /^\*\*([^*]+)\*\*:?$/;

export function Prose({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // Nothing written yet: the reasoning panel above is carrying the wait.
  if (text.trim().length === 0) return null;

  // Group consecutive bullets so a list renders as one list rather than as a
  // run of paragraphs that happen to start with a dash. Headings and numbered
  // steps get their own blocks so an answer has a shape you can skim, instead
  // of arriving as one undifferentiated slab of text.
  const blocks: { kind: 'p' | 'ul' | 'ol' | 'h'; lines: string[] }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) {
      // A blank line closes whatever was open, so two paragraphs stay two.
      if (blocks.length > 0) blocks.push({ kind: 'p', lines: [] });
      continue;
    }
    const heading = /^#{2,4}\s+(.*)$/.exec(line) ?? STANDALONE_BOLD.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const last = blocks[blocks.length - 1];

    if (heading) {
      blocks.push({ kind: 'h', lines: [heading[1]!.replace(/:$/, '')] });
    } else if (bullet) {
      if (last?.kind === 'ul') last.lines.push(bullet[1]!);
      else blocks.push({ kind: 'ul', lines: [bullet[1]!] });
    } else if (numbered) {
      if (last?.kind === 'ol') last.lines.push(numbered[1]!);
      else blocks.push({ kind: 'ol', lines: [numbered[1]!] });
    } else if (last?.kind === 'p' && last.lines.length > 0) {
      last.lines.push(line);
    } else {
      blocks.push({ kind: 'p', lines: [line] });
    }
  }

  return (
    <div className="cp__prose">
      {blocks
        .filter((b) => b.lines.length > 0)
        .map((block, bi) => {
          if (block.kind === 'h') {
            return (
              <h4 key={bi} className="cp__h">
                {block.lines[0]}
              </h4>
            );
          }
          if (block.kind === 'ul') {
            return (
              <ul key={bi} className="cp__list">
                {block.lines.map((l, li) => (
                  <li key={li}>{inline(l, `${bi}-${li}`)}</li>
                ))}
              </ul>
            );
          }
          if (block.kind === 'ol') {
            return (
              <ol key={bi} className="cp__list cp__list--num">
                {block.lines.map((l, li) => (
                  <li key={li}>{inline(l, `${bi}-${li}`)}</li>
                ))}
              </ol>
            );
          }
          return <p key={bi}>{inline(block.lines.join(' '), String(bi))}</p>;
        })}
      {/* A caret while tokens are still arriving, so a pause between them reads
          as "still writing" rather than as "finished, and that was all". */}
      {streaming && <span className="cp__caret" aria-hidden="true" />}
    </div>
  );
}
