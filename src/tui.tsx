/**
 * /close —— 关闭会话标签页插件（OpenCode V2 TUI）
 *
 * 用法（参数直接跟在斜杠命令后面）：
 *   /close               → 关闭当前活动标签页
 *   /close 3             → 关闭第 3 个标签页（单个序号）
 *   /close 1,3,5-7       → 关闭多个标签页（序号 / 区间混合，英文逗号分隔）
 *                           区间 ``a-b`` 为闭区间（a <= b），序号均从 1 开始；
 *                           执行前会先越界校验，任一越界则提示且不会关闭任何标签页。
 *   /close <关键词>       → 按标题匹配标签页（含一个匹配则直接关闭）
 *   /close <关键词>（多个匹配）→ 弹出多选选择器（默认全部勾选，可过滤、空格切换勾选，
 *                           回车确认关闭所有选中的标签）
 *
 * 无任何二次 confirm，关闭即关闭；会话内容不会删除，可稍后在会话列表重新打开。
 *
 * 实现要点：
 *  - keymap 命令必须在 ui.slot 的 render 回调（组件上下文，含 Keymap.Provider）中
 *    注册，这是官方运行时支持 keymap.layer 的方式；不要在 setup() 中直接调用
 *    ctx.keymap.layer()（会抛 Keymap.Provider missing）。render 返回 null 不渲染，
 *    用一个 registered 布尔防止重复注册。
 *  - 多选选择器用 ctx.ui.dialog.show(() => JSX) 渲染自定义 Solid 组件，
 *    键盘用 @opentui/solid 的 useKeyboard（evt.name / evt.sequence），
 *    采用"无聚焦的 filter 状态 + useKeyboard 收集字符"的方式（过滤框不收空格，
 *    空格键整体用于勾选切换）。
 *
 * 多语言：英文环境显示英文，中文环境（options.locale 或系统 LANG/LC_ALL 以 zh 开头）
 * 显示中文。
 */

/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import { TextAttributes, RGBA, type ScrollBoxRenderable, type KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"

// ---------------------------------------------------------------------------
// 语言检测：显式 options.locale > 系统 LANG/LC_ALL > 默认英文
// ---------------------------------------------------------------------------
function detectLocale(options: Record<string, unknown> | undefined): "en" | "zh" {
  const opt = options?.locale
  if (typeof opt === "string") {
    const l = opt.toLowerCase()
    if (l.startsWith("zh")) return "zh"
    if (l.startsWith("en")) return "en"
  }
  const lang = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "").toLowerCase()
  return lang.startsWith("zh") ? "zh" : "en"
}

// ---- 纯文本文案表 ----
const STRINGS = {
  cmdTitle: { en: "Close session tab", zh: "关闭会话标签页" },
  cmdDescription: {
    en: "Close the current tab, the N-th tab (single index or ranges like 1,3,5-7), or tabs matched by title. Usage: /close (current tab), /close 3 (N-th), /close 1,3-5 (indices/ranges), /close <keyword> (title match; opens a multi-select when several match). No confirmation is required.",
    zh: "关闭当前标签页、第 N 个标签页（单个序号或区间，如 1,3,5-7），或按标题匹配的标签页。用法：/close（关闭当前）、/close 3（第 N 个）、/close 1,3-5（序号/区间）、/close <关键词>（标题匹配，多个匹配时弹出多选选择器）。无需二次确认。",
  },
  notEnabled: { en: "Session tabs are not enabled in this TUI.", zh: "当前 TUI 未启用会话标签页。" },
  noTabs: { en: "There are no open tabs.", zh: "当前没有打开的标签页。" },
  success: { en: "Session tab closed", zh: "已关闭会话标签页" },
  failed: { en: "Failed to close the tab; it may no longer exist.", zh: "关闭失败，标签页可能已不存在。" },
} as const

// ---- 带参数文案表（模板函数）----
const SENDERS = {
  noNth: {
    en: (n: number, total: number) => `No tab #${n} (currently ${total} tabs).`,
    zh: (n: number, total: number) => `没有第 ${n} 个标签页（当前共 ${total} 个）。`,
  },
  noTitleMatch: {
    en: (q: string) => `No tab whose title contains "${q}".`,
    zh: (q: string) => `没有标题包含「${q}」的标签页。`,
  },
  invalidRange: {
    en: (v: string) => `Invalid range "${v}". Use single indices or a-b ranges, e.g. 1,3,5-7 (a must be <= b).`,
    zh: (v: string) => `无效的数字范围「${v}」。请使用单个序号或 a-b 区间（a <= b），如 1,3,5-7。`,
  },
  closedMany: {
    en: (n: number) => `Closed ${n} session tabs`,
    zh: (n: number) => `已关闭 ${n} 个会话标签页`,
  },
  failedMany: {
    en: (n: number) => `${n} session tabs could not be closed; they may no longer exist.`,
    zh: (n: number) => `${n} 个标签页关闭失败，可能已不存在。`,
  },
  closedPartly: {
    en: (ok: number, fail: number) => `Closed ${ok} session tabs; ${fail} could not be closed (they may no longer exist).`,
    zh: (ok: number, fail: number) => `已关闭 ${ok} 个标签页，其中 ${fail} 个关闭失败（可能已不存在）。`,
  },
  mcNone: {
    en: () => "No session tabs selected.",
    zh: () => "未选择任何标签页。",
  },
  mcTitle: {
    en: (n: number) => `Close ${n} session tab${n === 1 ? "" : "s"}`,
    zh: (n: number) => `关闭 ${n} 个标签页`,
  },
  mcFilter: { en: () => "Filter", zh: () => "过滤" },
  mcFilterPlaceholder: { en: () => "type to filter by title…", zh: () => "输入关键词过滤（空格用于勾选）…" },
  mcNoResults: { en: () => "No matching session tabs", zh: () => "没有匹配的标签页" },
  mcMove: { en: () => "↑/↓ move", zh: () => "↑/↓ 选择" },
  mcToggle: { en: () => "space toggle", zh: () => "空格 勾选" },
  mcConfirm: { en: () => "enter close", zh: () => "回车 关闭" },
  mcCancel: { en: () => "esc cancel", zh: () => "Esc 取消" },
} as const

type Locale = "en" | "zh"

// ---------------------------------------------------------------------------
// 数字 / 数字范围解析
// ---------------------------------------------------------------------------
// 匹配语法：单个整数 或 a-b 区间（a、b 为 1~4 位整数，a<=b），段之间英文逗号分隔；
// 段内/段间允许出现空白。示例：3 / 1,2,3 / 1-3 / 1, 3-5, 7
const RANGE_RE = /^\d{1,4}(\s*-\s*\d{1,4})?(\s*,\s*\d{1,4}(\s*-\s*\d{1,4})?)*$/

function isRangeSyntax(input: string): boolean {
  return RANGE_RE.test(input)
}

/**
 * 解析数字范围字符串，展开为一组 1-based 索引（去重、保持出现顺序）。
 * 语法不合法（如 a>b 的区间）返回 null。
 */
function parseRange(input: string): number[] | null {
  if (!isRangeSyntax(input)) return null
  const seen = new Set<number>()
  const out: number[] = []
  const add = (n: number) => {
    if (!seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  for (const rawSeg of input.split(",")) {
    const seg = rawSeg.trim()
    const dash = /^(\d{1,4})\s*-\s*(\d{1,4})$/.exec(seg)
    if (dash) {
      const a = Number(dash[1])
      const b = Number(dash[2])
      if (a > b) return null
      for (let i = a; i <= b; i++) add(i)
    } else {
      add(Number(seg))
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 多选选择器（自定义 dialog 内容）
// ---------------------------------------------------------------------------
type TabOption = { sessionID: string; title?: string }

type MultiSelectStrings = {
  title: (n: number) => string
  filter: string
  placeholder: string
  noResults: string
  move: string
  toggle: string
  confirm: string
  cancel: string
}

const FG_MUTED = RGBA.fromInts(140, 140, 140, 255)
const FG_DIM = RGBA.fromInts(108, 108, 108, 255)
const BG_CURSOR = RGBA.fromInts(255, 255, 255, 26)

function MultiSelect(props: {
  options: TabOption[]
  strings: MultiSelectStrings
  onConfirm: (sessionIDs: string[]) => void
  onCancel: () => void
}) {
  const [filter, setFilter] = createSignal("")
  const [cursor, setCursor] = createSignal(0)
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(
    new Set(props.options.map((o) => o.sessionID)),
  )

  const filtered = createMemo(() => {
    const q = filter().toLowerCase()
    if (!q) return props.options
    return props.options.filter((o) => (o.title ?? o.sessionID).toLowerCase().includes(q))
  })

  // 过滤后光标越界归一（clamp）
  const effectiveCursor = createMemo(() => {
    const len = filtered().length
    if (len === 0) return 0
    return Math.min(cursor(), len - 1)
  })

  let scroll: ScrollBoxRenderable | undefined

  const toggle = (sessionID: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(sessionID)) next.delete(sessionID)
      else next.add(sessionID)
      return next
    })
  }

  const toggleAtCursor = () => {
    const list = filtered()
    const idx = effectiveCursor()
    const opt = list[idx]
    if (opt) toggle(opt.sessionID)
  }

  const scrollToCursor = () => {
    if (!scroll || scroll.isDestroyed) return
    const list = filtered()
    const opt = list[effectiveCursor()]
    if (!opt) return
    const target = scroll.getChildren().find((child) => child.id === `mc:${opt.sessionID}`)
    if (!target) return
    const y = target.y - scroll.y
    if (y < 0) scroll.scrollBy(y)
    else if (y >= scroll.height && scroll.height > 0) scroll.scrollBy(y - scroll.height + 1)
  }

  createEffect(() => {
    // filter / 列表变化时：光标越界归一，并滚动跟随
    filtered()
    const len = filtered().length
    if (len === 0) {
      setCursor(0)
      return
    }
    if (cursor() >= len) setCursor(len - 1)
    scrollToCursor()
  })

  useKeyboard((evt: KeyEvent) => {
    if (evt.name === "up") {
      evt.preventDefault()
      evt.stopPropagation()
      const len = filtered().length
      if (len > 0) setCursor((c) => ((Math.min(c, len - 1) - 1 + len) % len))
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      evt.stopPropagation()
      const len = filtered().length
      if (len > 0) setCursor((c) => ((Math.min(c, len - 1) + 1) % len))
      return
    }
    if (evt.name === "return" || evt.name === "enter") {
      evt.preventDefault()
      evt.stopPropagation()
      const ids = props.options
        .filter((o) => selectedIds().has(o.sessionID))
        .map((o) => o.sessionID)
      props.onConfirm(ids)
      return
    }
    if (evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      props.onCancel()
      return
    }
    if (evt.name === "space") {
      // 空格：切换当前光标项选中/取消（不输入到过滤框）
      evt.preventDefault()
      evt.stopPropagation()
      toggleAtCursor()
      return
    }
    if (evt.name === "backspace") {
      evt.preventDefault()
      evt.stopPropagation()
      setFilter((f) => f.slice(0, -1))
      return
    }
    // 其余（字母/数字/标点等）输入到过滤框；忽略带修饰键的组合与空白/控制字符
    if (!evt.ctrl && !evt.meta && !evt.alt && !evt.option) {
      const ch = evt.sequence
      if (ch && ch.length === 1 && !/\s/.test(ch) && !/[\x00-\x1f\x7f]/.test(ch)) {
        evt.preventDefault()
        evt.stopPropagation()
        setFilter((f) => f + ch)
      }
    }
  })

  const str = props.strings

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD}>{str.title(selectedIds().size)}</text>
        <text fg={FG_MUTED} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>

      <box flexDirection="row" gap={1}>
        <text fg={FG_MUTED}>{str.filter}:</text>
        <Show
          when={filter()}
          fallback={<text fg={FG_DIM}>{str.placeholder}</text>}
        >
          <text>{filter()}</text>
        </Show>
      </box>

      <Show
        when={filtered().length > 0}
        fallback={
          <box paddingTop={1} paddingLeft={1}>
            <text fg={FG_MUTED}>{str.noResults}</text>
          </box>
        }
      >
        <scrollbox
          flexDirection="column"
          maxHeight={8}
          scrollbarOptions={{ visible: false }}
          ref={(r: ScrollBoxRenderable | undefined) => (scroll = r)}
        >
          <For each={filtered()}>
            {(opt) => {
              const isCursor = createMemo(() => filtered()[effectiveCursor()]?.sessionID === opt.sessionID)
              const isOn = createMemo(() => selectedIds().has(opt.sessionID))
              return (
                <box
                  id={`mc:${opt.sessionID}`}
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isCursor() ? BG_CURSOR : undefined}
                  onMouseUp={() => toggle(opt.sessionID)}
                  onMouseOver={() => {
                    const idx = filtered().findIndex((o) => o.sessionID === opt.sessionID)
                    if (idx !== -1) setCursor(idx)
                  }}
                >
                  <text fg={isOn() ? undefined : FG_MUTED} attributes={isCursor() ? TextAttributes.BOLD : undefined}>
                    [{isOn() ? "x" : " "}]
                  </text>
                  <text attributes={isCursor() ? TextAttributes.BOLD : undefined} wrapMode="none" overflow="hidden">
                    {opt.title ?? opt.sessionID}
                  </text>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </Show>

      <box flexDirection="row" gap={2} paddingTop={1} flexShrink={0}>
        <text fg={FG_DIM}>{str.move}</text>
        <text fg={FG_DIM}>{str.toggle}</text>
        <text fg={FG_DIM}>{str.confirm}</text>
        <text fg={FG_DIM}>{str.cancel}</text>
      </box>
    </box>
  )
}

// ---------------------------------------------------------------------------
// 插件定义
// ---------------------------------------------------------------------------
export default Plugin.define({
  id: "tab-close",
  setup(ctx) {
    const { ui } = ctx
    const tabs = ui.tabs

    // setup 在服务端执行，这里一次性算好 locale；render 回调通过闭包共用
    const locale = detectLocale(ctx.options)
    const t = (key: keyof typeof STRINGS) => STRINGS[key][locale]
    const s = (key: keyof typeof SENDERS, ...args: unknown[]) =>
      (SENDERS[key][locale] as (...a: unknown[]) => string)(...args)

    // render 运行在组件上下文（有 Keymap.Provider），在此注册 keymap 命令
    let registered = false
    ui.slot({
      append: "app",
      render: () => {
        if (registered) return null
        registered = true
        ctx.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            {
              id: "tab.close",
              title: t("cmdTitle"),
              description: t("cmdDescription"),
              group: "Session",
              palette: true,
              slash: { name: "close", arguments: true },
              enabled: () => tabs.enabled(),
              run: (input) => {
                void start(input)
              },
            },
          ],
        }))
        return null
      },
    })

    // ---- 入口 ----
    async function start(arg: string | undefined) {
      if (!tabs.enabled()) {
        ui.toast.show({ variant: "warning", title: t("cmdTitle"), message: t("notEnabled") })
        return
      }
      const list = tabs.list()
      if (!list.length) {
        ui.toast.show({ variant: "warning", title: t("cmdTitle"), message: t("noTabs") })
        return
      }

      const value = (arg ?? "").trim()

      // 1) 无参数 → 关闭当前活动标签页（省略 sessionID，无需 confirm）
      if (!value) {
        reportClose(closeCurrent())
        return
      }

      // 2) 数字 / 数字范围（含单个数字）
      if (isRangeSyntax(value)) {
        const indices = parseRange(value)
        if (!indices) {
          await ui.dialog.alert({ title: t("cmdTitle"), message: s("invalidRange", value) })
          return
        }
        // 先整体越界校验，任一越界则提示且不关闭任何标签页
        for (const n of indices) {
          if (n < 1 || n > list.length) {
            await ui.dialog.alert({ title: t("cmdTitle"), message: s("noNth", n, list.length) })
            return
          }
        }
        const targets = indices.map((n) => list[n - 1])
        reportClose(closeMany(targets.map((tab) => tab.sessionID)))
        return
      }

      // 3) 标题匹配
      const q = value.toLowerCase()
      const matches = list.filter((tab) => (tab.title ?? tab.sessionID).toLowerCase().includes(q))
      if (!matches.length) {
        await ui.dialog.alert({ title: t("cmdTitle"), message: s("noTitleMatch", value) })
        return
      }
      if (matches.length === 1) {
        reportClose(closeMany([matches[0].sessionID]))
        return
      }

      // 4) 多个匹配 → 多选选择器（默认全部选中，无二次确认）
      const selected = await openMultiSelect(
        matches.map((tab) => ({ sessionID: tab.sessionID, title: tab.title })),
        {
          title: (n: number) => s("mcTitle", n),
          filter: s("mcFilter"),
          placeholder: s("mcFilterPlaceholder"),
          noResults: s("mcNoResults"),
          move: s("mcMove"),
          toggle: s("mcToggle"),
          confirm: s("mcConfirm"),
          cancel: s("mcCancel"),
        },
      )
      if (!selected.length) {
        ui.toast.show({ variant: "warning", title: t("cmdTitle"), message: s("mcNone") })
        return
      }
      reportClose(closeMany(selected))
    }

    // ---- 弹出多选选择器，返回选中的 sessionID 数组（取消返回空数组）----
    function openMultiSelect(options: TabOption[], strings: MultiSelectStrings): Promise<string[]> {
      return new Promise((resolve) => {
        let settled = false
        const finish = (ids: string[]) => {
          if (settled) return
          settled = true
          ui.dialog.clear()
          resolve(ids)
        }
        ui.dialog.show(
          () => (
            <MultiSelect
              options={options}
              strings={strings}
              onConfirm={(ids) => finish(ids)}
              onCancel={() => finish([])}
            />
          ),
          // 兜底：dialog 被其它途径关闭（如宿主 clear）时也 settle
          () => finish([]),
        )
      })
    }

    // ---- 关闭当前活动标签页（tabs.close() 省略 sessionID）----
    function closeCurrent(): { ok: number; fail: number } {
      return tabs.close() ? { ok: 1, fail: 0 } : { ok: 0, fail: 1 }
    }

    // ---- 逐个关闭并汇总结果 ----
    function closeMany(sessionIDs: string[]): { ok: number; fail: number } {
      let ok = 0
      let fail = 0
      for (const id of sessionIDs) {
        if (tabs.close(id)) ok++
        else fail++
      }
      return { ok, fail }
    }

    function reportClose(result: { ok: number; fail: number }) {
      const total = result.ok + result.fail
      if (total === 0) {
        // 没有任何可关闭的项（例如当前无活动标签页且未传参）
        ui.toast.show({ variant: "info", message: t("noTabs") })
        return
      }
      if (result.fail === 0) {
        if (total === 1) {
          ui.toast.show({ variant: "success", message: t("success") })
        } else {
          ui.toast.show({ variant: "success", message: s("closedMany", total) })
        }
        return
      }
      if (result.ok === 0) {
        if (total === 1) {
          ui.toast.show({ variant: "error", message: t("failed") })
        } else {
          ui.toast.show({ variant: "error", message: s("failedMany", total) })
        }
        return
      }
      ui.toast.show({ variant: "error", message: s("closedPartly", result.ok, result.fail) })
    }
  },
})
