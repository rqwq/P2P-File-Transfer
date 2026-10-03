import React, { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

// Markdown rendering of chat messages (spec 9) through the sanitized
// renderer — the one sanctioned path for peer-supplied rich content.
// DOMPurify strips everything dangerous; raw HTML never reaches the DOM.

marked.setOptions({ breaks: true, gfm: true })

export function Markdown(props: { text: string }): React.JSX.Element {
  const html = useMemo(() => {
    const raw = marked.parse(props.text, { async: false }) as string
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS: [
        'b', 'i', 'em', 'strong', 'u', 's', 'del', 'code', 'pre', 'blockquote',
        'ul', 'ol', 'li', 'p', 'br', 'hr', 'a', 'img', 'span',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td'
      ],
      ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class'],
      ALLOW_DATA_ATTR: false
    })
  }, [props.text])
  return <div className="chat-text" dangerouslySetInnerHTML={{ __html: html }} />
}
