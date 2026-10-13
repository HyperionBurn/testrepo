// Tiny, safe Markdown renderer for LLM output. Produces React elements only:
// no dangerouslySetInnerHTML, no raw HTML, no links. Supports headings, paragraphs,
// bullet and numbered lists, fenced code, `code`, **bold** and *italic*.
import { Fragment, type ReactNode } from 'react'

export type MdBlock =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: 3 | 4 | 5; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string };

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: MdBlock[] = []
  let para: string[] = []
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null

  const flush = (): void => {
    if (para.length > 0) {
      out.push({ kind: 'p', text: para.join(' ') })
      para = []
    }
    if (list) {
      out.push(list)
      list = null
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '')
        i++
      }
      out.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = Math.min(5, Math.max(3, heading[1]!.length + 1)) as 3 | 4 | 5
      out.push({ kind: 'h', level, text: heading[2] ?? '' })
      continue
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const kind: 'ul' | 'ol' = bullet ? 'ul' : 'ol'
      const text = (bullet ?? numbered)?.[1] ?? ''
      if (para.length > 0) {
        out.push({ kind: 'p', text: para.join(' ') })
        para = []
      }
      if (!list || list.kind !== kind) {
        if (list) out.push(list)
        list = { kind, items: [] }
      }
      list.items.push(text)
      continue
    }
    if (list) {
      out.push(list)
      list = null
    }
    para.push(line.trim())
  }
  flush()
  return out
}

// One capture group: odd indices of split() are the matched spans.
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*)/

export function renderInline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') || part.startsWith('__')) return <strong key={i}>{part.slice(2, -2)}</strong>
    return <em key={i}>{part.slice(1, -1)}</em>
  })
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text)
  return (
    <div className={className ? `prose ${className}` : 'prose'}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'p':
            return <p key={i}>{renderInline(b.text)}</p>
          case 'h':
            return b.level === 3 ? (
              <h3 key={i}>{renderInline(b.text)}</h3>
            ) : b.level === 4 ? (
              <h4 key={i}>{renderInline(b.text)}</h4>
            ) : (
              <h5 key={i}>{renderInline(b.text)}</h5>
            )
          case 'ul':
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ol>
            )
          case 'code':
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            )
        }
      })}
    </div>
  )
}
