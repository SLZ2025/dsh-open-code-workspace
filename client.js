/**
 * Client half of dsh-open-code-workspace.
 *
 * DSH owns the `工作区` section header (`sidebar.workspaces`) and exposes no
 * toolbar slot there, so the button lives in the frame overlay (`shell.overlay`)
 * and tracks the header's first action button. Clicking it asks the Host half to
 * run the native `.code-workspace` chooser, aggregates the file's folders under
 * one junction directory, then registers that directory as a Workspace and opens
 * a blank Session in it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-open-code-workspace',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    const BASE = '/dsh-open-code-workspace/'
    const HEADER_SELECTOR = '[data-sidebar-workspace-header]'

    const dictionaries = {
      zh: {
        button: '打开工作区文件（.code-workspace）',
        busy: '正在读取工作区文件…',
        failed: '打开失败：',
        partial: (count) => `已打开，但有 ${count} 个文件夹链接失败。`,
        noFolders: '这个工作区文件里没有可用文件夹。',
      },
      en: {
        button: 'Open workspace file (.code-workspace)',
        busy: 'Reading the workspace file…',
        failed: 'Could not open: ',
        partial: (count) => `Opened, but ${count} folder link(s) failed.`,
        noFolders: 'This workspace file lists no existing folders.',
      },
    }
    const language = (document.documentElement.lang || navigator.language || 'en').toLowerCase()
    const text = language.startsWith('zh') ? dictionaries.zh : dictionaries.en

    async function post(action, body) {
      const response = await fetch(`${BASE}${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        cache: 'no-store',
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const message = (payload && (payload.message || payload.error)) || `HTTP ${response.status}`
        throw Object.assign(new Error(message), { status: response.status })
      }
      return payload
    }

    /** Place the overlay button where the shipped header's first action button sits. */
    function useHeaderAnchor(ref) {
      useEffect(() => {
        let frame = 0
        const place = () => {
          frame = 0
          const element = ref.current
          if (!element) return
          const header = document.querySelector(HEADER_SELECTOR)
          if (!header) {
            element.style.display = 'none'
            return
          }
          const headerRect = header.getBoundingClientRect()
          const input = header.querySelector('input')
          const buttons = Array.from(header.querySelectorAll('button')).filter((button) => {
            const rect = button.getBoundingClientRect()
            return rect.width >= 12 && rect.height >= 12
          })
          const searchWidth = input ? input.getBoundingClientRect().width : 0
          const visible = headerRect.width >= 150 && headerRect.height >= 18 && buttons.length > 0 && searchWidth <= 48
          if (!visible) {
            element.style.display = 'none'
            return
          }
          const left = Math.min(...buttons.map((button) => button.getBoundingClientRect().left))
          element.style.display = ''
          element.style.left = `${Math.round(left - 2)}px`
          element.style.top = `${Math.round((headerRect.top + headerRect.bottom) / 2)}px`
        }
        const schedule = () => {
          if (frame === 0) frame = requestAnimationFrame(place)
        }
        schedule()
        const mutation = new MutationObserver(schedule)
        mutation.observe(document.body, { childList: true, subtree: true, attributes: true })
        const resize = new ResizeObserver(schedule)
        resize.observe(document.documentElement)
        window.addEventListener('resize', schedule)
        window.addEventListener('scroll', schedule, true)
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
          mutation.disconnect()
          resize.disconnect()
          window.removeEventListener('resize', schedule)
          window.removeEventListener('scroll', schedule, true)
        }
      }, [ref])
    }

    function folderIcon(size) {
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M2.7 5.2h3.6l1.1 1.3h5.8v1.1' }),
        React.createElement('path', { d: 'M2.7 5.2v6.2' }),
        React.createElement('path', { d: 'M2.7 11.4 4.1 7.5h9.8l-1.4 5.6H3.9z' }),
      )
    }

    function spinner(size) {
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
          style: { animation: 'dsocw-spin 0.9s linear infinite' },
        },
        React.createElement('path', { d: 'M8 1.8a6.2 6.2 0 1 1-6.2 6.2' }),
      )
    }

    function makeOverlay(ctx) {
      return function WorkspaceFileButton() {
        const ref = useRef(null)
        const [busy, setBusy] = useState(false)
        const [hover, setHover] = useState(false)
        const [notice, setNotice] = useState(null)
        useHeaderAnchor(ref)

        useEffect(() => {
          if (notice === null) return undefined
          const timer = setTimeout(() => setNotice(null), 8000)
          return () => clearTimeout(timer)
        }, [notice])

        const run = useCallback(async () => {
          if (busy) return
          setBusy(true)
          setNotice(null)
          try {
            const picked = await post('pick')
            if (!picked || typeof picked.path !== 'string') return
            const opened = await post('multiroot', { path: picked.path })
            const workspaces = ctx.get('workspaces')
            const uiWorkspace = ctx.get('uiWorkspace')
            const created = await workspaces.create({ path: opened.path })
            const workspaceId = created?.workspaceId ?? created?.workspace?.workspaceId
            if (!workspaceId) throw new Error('workspace-unavailable')
            uiWorkspace.startSession(workspaceId, { clearPreviousDraft: false })
            if (opened.failed?.length > 0) {
              setNotice({ tone: 'warn', text: text.partial(opened.failed.length) })
            }
          } catch (caught) {
            if (caught && caught.status === 409) return
            setNotice({
              tone: 'error',
              text: `${text.failed}${caught instanceof Error ? caught.message : String(caught)}`,
            })
          } finally {
            setBusy(false)
          }
        }, [busy])

        const button = React.createElement(
          'button',
          {
            ref,
            type: 'button',
            title: busy ? text.busy : text.button,
            'aria-label': text.button,
            'aria-busy': busy,
            onClick: () => {
              void run()
            },
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: {
              position: 'fixed',
              transform: 'translate(-100%, -50%)',
              display: 'none',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              padding: 0,
              margin: 0,
              border: 'none',
              borderRadius: 6,
              background: hover ? 'color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)' : 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              cursor: busy ? 'progress' : 'pointer',
              opacity: busy ? 0.7 : 1,
              zIndex: 30,
              pointerEvents: 'auto',
            },
          },
          busy ? spinner(13) : folderIcon(15),
        )

        if (notice === null) return button
        return React.createElement(
          React.Fragment,
          null,
          button,
          React.createElement(
            'div',
            {
              role: 'status',
              style: {
                position: 'fixed',
                left: 8,
                right: 8,
                bottom: 8,
                zIndex: 31,
                padding: '8px 10px',
                borderRadius: 8,
                background: 'var(--dsw-alias-bg-overlay, #2b2b2b)',
                color:
                  notice.tone === 'error'
                    ? 'var(--dsw-alias-state-error-primary, #ff8f8f)'
                    : 'var(--dsw-alias-state-warn-primary, #ffcf70)',
                boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
                fontSize: 12,
                lineHeight: 1.4,
                pointerEvents: 'auto',
              },
            },
            notice.text,
          ),
        )
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dsocw = ''
          style.textContent = '@keyframes dsocw-spin { to { transform: rotate(360deg) } }'
          document.head.append(style)
          return () => style.remove()
        }, 'dsh-open-code-workspace: style')
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-open-code-workspace', order: 60 }, makeOverlay(ctx)),
        )
      },
    }
  },
})
