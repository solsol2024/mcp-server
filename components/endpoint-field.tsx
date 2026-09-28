'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function EndpointField({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    if (typeof window === 'undefined') return
    const url = `${window.location.origin}${path}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable; no-op
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 font-mono text-sm text-foreground">
      <span className="text-muted-foreground" aria-hidden="true">
        $
      </span>
      <span className="flex-1 truncate">{path}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        onClick={handleCopy}
        aria-label="Copy endpoint URL"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}
