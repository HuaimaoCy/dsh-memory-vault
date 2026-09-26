/**
 * dsh-memory-vault, browser half: the **知识记忆库** sidebar entry, the tile
 * board it opens in the main column, and the knowledge-application control the
 * composer carries.
 *
 * The presentation layer is built from the shell's own primitives
 * (`@deepseek-ai/dsh-client-ui-primitives`) and its design tokens
 * (`--dsw-*`), so the panel inherits the application's typography, spacing,
 * colors, and light/dark theming instead of approximating them. Markdown and
 * LaTeX come from the shell's `MarkdownText`, which renders GFM with KaTeX.
 *
 * The page talks to the Host half over the plugin's own same-origin route
 * (`/memory-vault`) rather than a Typert Remote namespace, because mounting a
 * Remote namespace would require this bundle to take part in the harness's
 * Client assembly build — a step an out-of-tree plugin cannot join.
 *
 * This file is the built artifact shape by hand: a CJS closure handed to
 * `window.__ModuleLoader__.load`, requiring only the browser module table's
 * baseline specifiers so no second copy of React can appear.
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-vault',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const {
      Button, Pill, Tag, Input, Switch, MarkdownText, extractMarkdownPlainText,
      IconSearchOutlineMedium, IconPlusOutlineMedium, IconRefreshOutlineMedium,
      IconTrashOutlineMedium, IconChevronLeftOutlineMedium, IconContextInjectionOutlineMedium,
      IconChecklistOutlineMedium, IconArchiveOutlineMedium, IconArchiveOffOutlineMedium,
      IconCheckOutlineMedium,
    } = primitives
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'memoryVault'
    /** Panel id shared by the sidebar entry and the main-column page. */
    const PANEL_ID = 'memory-vault'
    /** Same-origin route registered by the Host half. */
    const ENDPOINT = '/memory-vault'
    /** Marker header the Host requires on mutating calls; also forces a CORS preflight off-origin. */
    const MARKER = 'x-dsh-memory-vault'
    /** Poll interval while the page is visible, in milliseconds. */
    const POLL_MS = 5000
    /** Entries requested per load. */
    const PAGE_LIMIT = 120
    /** The two system tags, in display order. */
    const AUTO_TAGS = ['AI自动总结', '人工输入']
    /** Entry kinds offered by the editor. */
    const KINDS = [
      ['summary', '摘要'], ['fact', '事实'], ['preference', '偏好'],
      ['decision', '决策'], ['task', '任务'], ['note', '其他'],
    ]

    const STRINGS = {
      zh: {
        panel: '知识记忆库',
        title: '知识与记忆库',
        subtitle: '记忆组是一级容器；每条记忆可自由归属「对话记忆」或「知识库」。',
        refresh: '刷新',
        search: '搜索记忆（空格分隔多个关键词）',
        clear: '清除',
        conversation: '对话记忆',
        knowledge: '知识库',
        groups: '记忆组管理',
        groupCount: '组',
        entries: '条',
        autoSummary: '自动总结',
        autoSummaryOn: '已开启阈值自动总结',
        autoSummaryOff: '未开启阈值自动总结',
        flip: '切换归属',
        remove: '删除',
        removeGroupConfirm: '删除该记忆组及其全部记忆？',
        removeEntryConfirm: '删除这条记忆？',
        moveToKnowledge: '移入知识库',
        moveToConversation: '移入对话记忆',
        scopeShortConversation: '对话',
        scopeShortKnowledge: '知识',
        newEntry: '新建记忆',
        newGroup: '新建记忆组',
        groupName: '记忆组名称',
        create: '创建',
        cancel: '取消',
        save: '保存',
        edit: '编辑',
        back: '返回',
        loading: '加载中…',
        missing: '这条记忆已不在记忆库中。',
        emptyFiltered: '没有符合当前筛选的记忆。',
        boardEmpty: '还没有磁贴。',
        tags: '标签',
        addTag: '添加标签…',
        add: '添加',
        groupBy: '分组',
        groupByGroup: '按记忆组',
        groupByTag: '按标签',
        groupByNone: '不分组',
        detailGroup: '记忆组',
        detailScope: '归属',
        detailKind: '类型',
        detailSource: '来源',
        detailCreated: '创建',
        detailUpdated: '更新',
        detailId: 'ID',
        untitled: '（无标题）',
        content: '正文',
        titleField: '标题',
        kindField: '类型',
        groupField: '记忆组',
        scopeField: '归属',
        created: '已创建记忆。',
        saved: '已保存。',
        manual: '人工输入',
        generated: 'AI自动总结',
        moveToGroup: '移动到记忆组',
        all: '全部',
        facets: '筛选',
        preview: '预览',
        source: '源码',
        tileHint: '拖动磁贴到「全部 / 知识库 / 对话记忆」改归属，拖到标签上即加标签。',
        apply: '知识',
        applyNone: '未应用',
        applyOff: '已关闭',
        applyDefault: '默认',
        applyEntries: '条记忆',
        applyReset: '恢复默认',
        applyClear: '全部关闭',
        applyDefaultNote: '新会话默认应用',
        knowledgeTitle: '本会话的知识',
        knowledgeSub: '拖动磁贴（或点击磁贴）即可把记忆组应用到这个会话：应用后组里的记忆直接进入本会话的系统提示。',
        knowledgeNone: '本会话当前没有应用任何记忆组。',
        knowledgeListNeedsRestart: '有记忆正在注入，但清单需要重启 dsh web 后显示（当前 Host 半仍是旧版）。',
        knowledgeInjected: '正在使用',
        knowledgeTruncated: '已达注入上限，其余内容模型需要自己检索。',
        knowledgeLimits: '注入上限',
        knowledgeApplied: '已应用',
        knowledgeAvailable: '可应用',
        knowledgeDropApply: '拖到这里即应用',
        knowledgeDropRemove: '拖到这里即移除',
        knowledgeAppliedEmpty: '还没有应用任何记忆组',
        knowledgeAvailableEmpty: '所有记忆组都已应用',
        knowledgeToggleHint: '点击可切换，拖动可移动到另一区',
        bindLabel: '总结写入',
        bindDefault: '默认组',
        bindHint: '指定本会话的自动总结与默认手动总结写入哪个记忆组；与上面"应用哪些知识"是两件事。',
        newChatLabel: '记忆',
        newChatHint: '选中的记忆组会直接进入这个新对话的系统提示；不选则按默认设置。',
        newChatManage: '对话开始后，可在顶部的「知识」页签里继续调整。',
        newChatNone: '这个新对话还没有应用任何记忆组。',
        priorityLabel: '优先级',
        priorityHint: '越高越优先：在提示索引里排得更前，注入预算不够时先进入系统提示。',
        priorityShort: 'P',
        viaSession: '本会话指定',
        viaGroup: '随组注入',
        baseLabel: '底层 prompt',
        baseHint: '标为「底层 prompt」的记忆每次对话都会注入，且不占用本会话可用的知识数量；适合长期有效的基础约定。',
        baseBadge: '底层',
        baseTitle: '底层 prompt',
        baseEmpty: '还没有底层 prompt 记忆。在记忆详情里把长期有效的基础约定标上即可。',
        baseCount: '不占知识数量',
        limitsLabel: '可用知识数量',
        limitsHint: '本会话最多注入多少条已应用的知识；底层 prompt 不计入这个数量。',
        curateReview: 'AI 整理（预览）',
        curateApply: '按建议归类',
        curateBusy: '整理中…',
        curateHint: '用一次模型调用判断每条记忆是可复用还是单次性，并给出归类建议。',
        curateEmpty: '模型没有给出可用的判断。',
        curateReusable: '可复用',
        curateOneoff: '单次性',
        hide: '隐藏',
        unhide: '恢复',
        hidden: '已隐藏',
        showHidden: '显示隐藏',
        hideHint: '隐藏后默认不再出现在检索与提示里，可随时恢复。',
        hideNeedsRestart: '隐藏需要重启 dsh web 才可用：当前进程仍运行旧版 Host 半。停掉服务后在仓库根目录执行 pnpm run start:web',
        visibility: '可见性',
        visible: '正常',
        select: '多选',
        exitSelect: '退出多选',
        selectAll: '全选',
        selectNone: '取消全选',
        loadMore: '加载更多',
        selectedCount: '已选',
        bulkTag: '加标签',
        bulkTagPlaceholder: '标签名，回车确认',
        bulkDeleteConfirm: '删除选中的记忆？此操作不可撤销。',
        bulkClear: '取消选择',
      },
      en: {
        panel: 'Memory Vault',
        title: 'Knowledge and Memory Vault',
        subtitle: 'Groups are containers; every memory is assigned to conversation memory or the knowledge base.',
        refresh: 'Refresh',
        search: 'Search memories (space-separated terms)',
        clear: 'Clear',
        conversation: 'Conversation memory',
        knowledge: 'Knowledge base',
        groups: 'Manage groups',
        groupCount: 'groups',
        entries: 'entries',
        autoSummary: 'Auto-summary',
        autoSummaryOn: 'Threshold summarization is on',
        autoSummaryOff: 'Threshold summarization is off',
        flip: 'Switch assignment',
        remove: 'Delete',
        removeGroupConfirm: 'Delete this group and every memory in it?',
        removeEntryConfirm: 'Delete this memory?',
        moveToKnowledge: 'Move to knowledge base',
        moveToConversation: 'Move to conversation memory',
        scopeShortConversation: 'Chat',
        scopeShortKnowledge: 'Knowledge',
        newEntry: 'New memory',
        newGroup: 'New group',
        groupName: 'Group name',
        create: 'Create',
        cancel: 'Cancel',
        save: 'Save',
        edit: 'Edit',
        back: 'Back',
        loading: 'Loading…',
        missing: 'This memory is no longer in the vault.',
        emptyFiltered: 'No memory matches the current filter.',
        boardEmpty: 'No tiles yet.',
        tags: 'Tags',
        addTag: 'Add a tag…',
        add: 'Add',
        groupBy: 'Group by',
        groupByGroup: 'memory group',
        groupByTag: 'tag',
        groupByNone: 'none',
        detailGroup: 'Group',
        detailScope: 'Assignment',
        detailKind: 'Kind',
        detailSource: 'Source',
        detailCreated: 'Created',
        detailUpdated: 'Updated',
        detailId: 'ID',
        untitled: '(untitled)',
        content: 'Body',
        titleField: 'Title',
        kindField: 'Kind',
        groupField: 'Group',
        scopeField: 'Assignment',
        created: 'Memory created.',
        saved: 'Saved.',
        manual: 'Hand-written',
        generated: 'AI summary',
        moveToGroup: 'Move to group',
        all: 'All',
        facets: 'Filter',
        preview: 'Preview',
        source: 'Source',
        tileHint: 'Drag a tile onto All / Knowledge base / Conversation memory to reassign it, or onto a tag to label it.',
        apply: 'Knowledge',
        applyNone: 'none applied',
        applyOff: 'off',
        applyDefault: 'default',
        applyEntries: 'memories',
        applyReset: 'Use defaults',
        applyClear: 'Apply nothing',
        applyDefaultNote: 'New conversations apply',
        knowledgeTitle: 'Knowledge in this conversation',
        knowledgeSub: 'Drag a tile (or click it) to apply that memory group to this conversation: an applied group\'s memories go straight into its system prompt.',
        knowledgeNone: 'This conversation applies no memory groups.',
        knowledgeListNeedsRestart: 'Memories are being injected, but the list needs a dsh web restart (this process still runs the previous Host half).',
        knowledgeInjected: 'In use',
        knowledgeTruncated: 'The injection cap is reached; the model must search for the rest.',
        knowledgeLimits: 'Injection cap',
        knowledgeApplied: 'Applied',
        knowledgeAvailable: 'Available',
        knowledgeDropApply: 'Drop here to apply',
        knowledgeDropRemove: 'Drop here to remove',
        knowledgeAppliedEmpty: 'No group applied yet',
        knowledgeAvailableEmpty: 'Every group is applied',
        knowledgeToggleHint: 'Click to toggle, drag to move between the two areas',
        bindLabel: 'Summaries go to',
        bindDefault: 'Default group',
        bindHint: 'Which group this conversation\'s summaries are filed into — a different question from which knowledge it reads.',
        newChatLabel: 'Memory',
        newChatHint: 'Checked groups go straight into this new conversation\'s system prompt; nothing checked means the deployment default applies.',
        newChatManage: 'Once the conversation starts, the 知识 tab at the top continues the same choice.',
        newChatNone: 'This new conversation applies no memory groups yet.',
        priorityLabel: 'Priority',
        priorityHint: 'Higher wins: it sorts earlier in the prompt index and is injected first when the budget is tight.',
        priorityShort: 'P',
        viaSession: 'picked here',
        viaGroup: 'via group',
        baseLabel: 'Base prompt',
        baseHint: 'A base-prompt memory is injected into every conversation and does not consume its knowledge quota. Use it for standing conventions.',
        baseBadge: 'base',
        baseTitle: 'Base prompt',
        baseEmpty: 'No base-prompt memories yet. Mark a standing convention on its detail screen.',
        baseCount: 'not counted',
        limitsLabel: 'Knowledge quota',
        limitsHint: 'How many applied memories this conversation injects; base-prompt memories are not counted.',
        curateReview: 'AI review',
        curateApply: 'Apply verdicts',
        curateBusy: 'Reviewing…',
        curateHint: 'One model call decides whether each memory is reusable or one-off, and suggests where it belongs.',
        curateEmpty: 'The model returned no usable verdicts.',
        curateReusable: 'reusable',
        curateOneoff: 'one-off',
        hide: 'Hide',
        unhide: 'Restore',
        hidden: 'Hidden',
        showHidden: 'Show hidden',
        hideHint: 'A hidden memory leaves search and the prompt until you restore it.',
        hideNeedsRestart: 'Hiding needs a dsh web restart (this process still runs the previous Host half)',
        visibility: 'Visibility',
        visible: 'Visible',
        select: 'Select',
        exitSelect: 'Done',
        selectAll: 'Select all',
        selectNone: 'Clear all',
        loadMore: 'Load more',
        selectedCount: 'Selected',
        bulkTag: 'Add tag',
        bulkTagPlaceholder: 'Tag name, Enter to apply',
        bulkDeleteConfirm: 'Delete the selected memories? This cannot be undone.',
        bulkClear: 'Deselect',
      },
    }

    /** Markdown chrome the shell's renderer asks for; a stable identity per language. */
    const MARKDOWN_LABELS = {
      zh: { code: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '不换行' }, footnotes: '脚注' },
      en: { code: { codeLabel: 'Code', wrapLabel: 'Wrap lines', unwrapLabel: 'No wrap' }, footnotes: 'Footnotes' },
    }

    /** Stylesheet for the page, rendered as a React element so unmounting removes it. */
    function StyleSheet() {
      return h('style', null, `
.dsmv, .dsmv-dock {
  --dsmv-ease-out: cubic-bezier(.23, 1, .32, 1);
  /* Type scales with the reader's text-size setting instead of a fixed px
     ladder, so the panel grows with the rest of the shell. */
  --dsmv-fs-title: calc(var(--dsh-content-font-size, 14px) + 1px);
  --dsmv-fs-body: var(--dsh-content-font-size, 14px);
  --dsmv-fs-small: calc(var(--dsh-content-font-size, 14px) - 2px);
  --dsmv-fs-cap: calc(var(--dsh-content-font-size, 14px) - 3px);
  --dsmv-lh-body: calc(var(--dsh-content-font-size, 14px) + 8px);
  --dsmv-lh-small: calc(var(--dsh-content-font-size, 14px) + 6px);
  --dsmv-material: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family);
}
.dsmv {
  height: 100%; display: flex; flex-direction: column;
}
/* The new-conversation strip sits above the composer, so it flows instead of
   filling: a panel that claimed the full height would push the composer away. */
.dsmv-dock {
  display: flex; flex-direction: column; gap: 6px; align-items: flex-start;
  padding: 0 2px 6px; max-width: 100%;
}
.dsmv-scroll {
  flex: 1 1 auto; overflow: auto; padding: 20px 24px 32px; display: flex; flex-direction: column; gap: 14px;
  opacity: 1; transition: opacity 180ms var(--dsmv-ease-out), filter 180ms var(--dsmv-ease-out);
  @starting-style { opacity: 0; filter: blur(2px); }
}
.dsmv-head { display: flex; align-items: flex-start; gap: 12px; }
/* Tracking is size-specific: headings tighten, small caps text opens up. */
.dsmv-title { margin: 0; font-size: var(--dsmv-fs-title); font-weight: 600; line-height: var(--dsmv-lh-small); letter-spacing: -.006em; }
.dsmv-sub { font-size: var(--dsmv-fs-small); line-height: var(--dsmv-lh-body); color: var(--dsw-alias-label-tertiary); }
.dsmv-meta { font-size: var(--dsmv-fs-small); line-height: var(--dsmv-lh-small); color: var(--dsw-alias-label-tertiary); }
.dsmv-cap { font-size: var(--dsmv-fs-cap); line-height: var(--dsmv-lh-small); letter-spacing: .012em; color: var(--dsw-alias-label-caption); }
.dsmv-col { display: flex; flex-direction: column; gap: 10px; }
.dsmv-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dsmv-facets { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.dsmv-spacer { flex: 1 1 auto; }
.dsmv-board { display: grid; grid-template-columns: repeat(auto-fill, minmax(258px, 1fr)); gap: 12px; padding: 2px 0 8px; }
.dsmv-tile {
  position: relative; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px;
  min-width: 0; cursor: pointer; border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-settings-card-fill);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-settings-card-stroke);
  transition: transform 160ms var(--dsmv-ease-out);
  opacity: 1;
  @starting-style { opacity: 0; transform: translateY(4px); }
}
/* The hover elevation rides on an opacity-animated overlay: animating
   box-shadow itself repaints the tile on every frame. */
.dsmv-tile::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  box-shadow: inset 0 0 0 1px var(--dsw-elevation-stroke-color), var(--dsw-elevation-soft);
  opacity: 0; transition: opacity 160ms var(--dsmv-ease-out);
}
/* Selection is a ring on the tile itself, so the whole surface reads as the
   hit target rather than a small checkbox alone. */
.dsmv-tile--sel {
  box-shadow: inset 0 0 0 1.5px var(--dsw-alias-link);
  background: color-mix(in srgb, var(--dsw-alias-link) 10%, var(--dsw-alias-settings-card-fill));
}
.dsmv-check {
  position: absolute; top: 8px; right: 10px; width: 18px; height: 18px; border-radius: 999px;
  display: inline-flex; align-items: center; justify-content: center; color: #fff;
  border: 1.5px solid var(--dsw-alias-border-l3, var(--dsw-elevation-stroke-color));
  background: var(--dsw-alias-bg-base);
  transition: background 120ms var(--dsmv-ease-out), border-color 120ms var(--dsmv-ease-out);
}
.dsmv-check--on { border-color: var(--dsw-alias-link); background: var(--dsw-alias-link); }
/* Controls built from divs and spans still have to show where the keyboard is. */
.dsmv-tile:focus-visible, .dsmv-gtile:focus-visible, .dsmv-tagbtn:focus-visible,
.dsmv-sec > summary:focus-visible {
  outline: 2px solid var(--dsw-alias-link);
  outline-offset: 2px;
}
/* A floating action bar is a functional layer, so it is a translucent material
   rather than a solid block sitting on the content. */
.dsmv-actionbar {
  position: sticky; bottom: 0; z-index: 2; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  margin-top: 4px; padding: 10px 14px; border-radius: var(--dsw-radius-lg);
  background: color-mix(in srgb, var(--dsw-alias-bg-overlay) 82%, transparent);
  backdrop-filter: var(--dsmv-material); -webkit-backdrop-filter: var(--dsmv-material);
  box-shadow: var(--dsw-elevation-panel);
  opacity: 1; transform: translateY(0) scale(1);
  transition: opacity 200ms var(--dsmv-ease-out), transform 200ms var(--dsmv-ease-out);
  @starting-style { opacity: 0; transform: translateY(8px) scale(.98); }
}
.dsmv-actionbar--out { opacity: 0; transform: translateY(8px) scale(.98); }
@media (hover: hover) and (pointer: fine) {
  .dsmv-tile:hover { transform: translateY(-1px); }
  .dsmv-tile:hover::after { opacity: 1; }
  .dsmv-tagbtn:hover { opacity: .82; }
  .dsmv-sec > summary:hover { color: var(--dsw-alias-label-primary); }
}
/* Press feedback: the interface should confirm it heard the press. */
.dsmv-tile:active { transform: scale(.995); transition-duration: 100ms; }
.dsmv-tile--hidden { opacity: .55; }
.dsmv-tile-title {
  font-size: 13px; font-weight: 600; line-height: 20px; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.dsmv-tile-body {
  font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-secondary); overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
}
.dsmv-tile-tags { display: flex; gap: 4px; flex-wrap: wrap; }
/* Assignment is a two-state choice, so the tile carries it as a two-segment
   control: the current side is lit and the other side is one press away. */
.dsmv-seg { display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0; }
.dsmv-tile-foot {
  display: flex; gap: 6px; align-items: center; margin-top: auto; flex-wrap: wrap;
  font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-caption);
}
.dsmv-sec { border: none; margin: 0; }
.dsmv-sec > summary {
  cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px;
  padding: 6px 2px; font-size: 12px; line-height: 20px; border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-secondary);
}
.dsmv-sec > summary::-webkit-details-marker { display: none; }
.dsmv-sec > summary::before {
  content: '›'; font-size: 14px; color: var(--dsw-alias-label-caption);
  transition: transform 160ms var(--dsmv-ease-out);
}
.dsmv-sec[open] > summary::before { transform: rotate(90deg); }
.dsmv-sec-body { display: flex; flex-direction: column; gap: 4px; padding: 4px 0 8px; }
.dsmv-card {
  display: flex; flex-direction: column; gap: 14px; padding: 16px 18px;
  border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-settings-card-fill);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-settings-card-stroke);
}
.dsmv-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.dsmv-grid { display: grid; grid-template-columns: max-content 1fr; gap: 8px 18px; font-size: 12px; line-height: 20px; margin: 0; align-items: baseline; }
.dsmv-grid dt { color: var(--dsw-alias-label-tertiary); }
.dsmv-grid dd { margin: 0; }
.dsmv-mark { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent); color: inherit; border-radius: 3px; padding: 0 2px; }
.dsmv-tagbtn { display: inline-flex; cursor: pointer; border-radius: 999px; opacity: 1; transition: opacity 140ms var(--dsmv-ease-out); }
.dsmv-tagbtn--active { outline: 1.5px solid var(--dsw-alias-link); outline-offset: 1px; }
.dsmv-empty { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-caption); padding: 10px 2px; }
.dsmv-error { font-size: 12px; line-height: 20px; color: var(--dsw-alias-state-error-primary); }
.dsmv-ok { font-size: 12px; line-height: 20px; color: var(--dsw-alias-state-success-primary); }
/* Two drop areas make application a move: applied groups on top, the rest
   below, and a tile travels between them by pointer or by click. */
.dsmv-zone {
  display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px;
  border-radius: var(--dsw-radius-lg); min-height: 76px;
  border: 1px dashed color-mix(in srgb, currentColor 18%, transparent);
  transition: border-color 160ms var(--dsmv-ease-out), background 160ms var(--dsmv-ease-out);
}
.dsmv-zone--over {
  border-color: var(--dsw-alias-link);
  background: color-mix(in srgb, var(--dsw-alias-link) 8%, transparent);
}
.dsmv-zone-head { display: flex; gap: 8px; align-items: baseline; }
.dsmv-gboard { display: grid; grid-template-columns: repeat(auto-fill, minmax(184px, 1fr)); gap: 8px; }
.dsmv-gtile {
  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; min-width: 0; cursor: grab;
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-settings-card-fill);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-settings-card-stroke);
  opacity: 1; transition: transform 160ms var(--dsmv-ease-out), box-shadow 160ms var(--dsmv-ease-out);
  @starting-style { opacity: 0; transform: translateY(3px); }
}
.dsmv-gtile-name { font-size: var(--dsmv-fs-small); font-weight: 600; line-height: var(--dsmv-lh-small); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsmv-gtile-desc {
  font-size: var(--dsmv-fs-cap); line-height: var(--dsmv-lh-small); color: var(--dsw-alias-label-tertiary); overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
@media (hover: hover) and (pointer: fine) {
  .dsmv-gtile:hover { transform: translateY(-1px); box-shadow: inset 0 0 0 1px var(--dsw-elevation-stroke-color), var(--dsw-elevation-soft); }
}
.dsmv-gtile:active { transform: scale(.99); transition-duration: 100ms; }
/* One injected memory, shown the way the model receives it. */
.dsmv-kitem {
  display: flex; flex-direction: column; gap: 8px; padding: 12px 14px;
  border-radius: var(--dsw-radius-md);
  background: color-mix(in srgb, currentColor 3%, transparent);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-settings-card-stroke);
}
.dsmv-kbody { font-size: var(--dsmv-fs-small); line-height: var(--dsmv-lh-body); }
/* Reduced transparency gets an opaque surface instead of a worse blurred one. */
@media (prefers-reduced-transparency: reduce) {
  .dsmv-actionbar {
    background: var(--dsw-alias-bg-overlay);
    backdrop-filter: none; -webkit-backdrop-filter: none;
  }
}
/* More contrast turns the material edge into a defined hairline. */
@media (prefers-contrast: more) {
  .dsmv-actionbar { box-shadow: inset 0 0 0 1px var(--dsw-alias-label-primary), var(--dsw-elevation-panel); }
}
@media (prefers-reduced-motion: reduce) {
  .dsmv-tile, .dsmv-tagbtn, .dsmv-tile::after, .dsmv-scroll,
  .dsmv-sec > summary::before, .dsmv-actionbar, .dsmv-check {
    transition-duration: 1ms;
  }
  .dsmv-tile:active, .dsmv-tile { transform: none; }
  .dsmv-actionbar { transform: none; }
  .dsmv-scroll { filter: none; }
}
`)
    }

    /**
     * Call one Host-side vault operation.
     * @param {string} op - Operation name.
     * @param {Record<string, unknown>} [params] - Query parameters for reads.
     * @param {Record<string, unknown>} [body] - JSON body for writes.
     * @returns {Promise<Record<string, any>>} The operation result.
     */
    async function call(op, params, body) {
      const url = new URL(ENDPOINT, window.location.origin)
      url.searchParams.set('op', op)
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || value === '') continue
        if (Array.isArray(value)) {
          // Repeated parameters carry a list, which is how the panel asks the
          // server for the intersection of several tags at once.
          for (const item of value) url.searchParams.append(key, String(item))
          continue
        }
        url.searchParams.set(key, String(value))
      }
      const response = await fetch(url, body === undefined
        ? { headers: { [MARKER]: '1' } }
        : {
            method: 'POST',
            headers: { [MARKER]: '1', 'content-type': 'application/json' },
            body: JSON.stringify({ op, ...body }),
          })
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${String(response.status)}` }))
      if (payload.ok !== true) throw new Error(String(payload.error ?? `HTTP ${String(response.status)}`))
      return payload.result
    }

    /**
     * Split a search box value into terms.
     * @param {string} query - Raw query.
     * @returns {string[]} Trimmed, lowercased, de-duplicated terms.
     */
    function termsOf(query) {
      return [...new Set(String(query ?? '').toLowerCase().split(/\s+/).map(term => term.trim()).filter(term => term !== ''))]
    }

    /**
     * The provenance tag of one entry.
     *
     * The Host half stores this tag on every entry; deriving it here as well
     * keeps the page correct while an older Host half is still running, which
     * is the normal state after this file alone is hot-reloaded.
     * @param {Record<string, any>} entry - Entry view.
     * @returns {string} The system tag.
     */
    function autoTagOf(entry) {
      return entry.autoTag ?? (entry.source === 'auto-summary' ? 'AI自动总结' : '人工输入')
    }

    /**
     * Every tag of one entry, provenance first.
     * @param {Record<string, any>} entry - Entry view.
     * @returns {string[]} Tags in display order.
     */
    function tagsOf(entry) {
      const system = autoTagOf(entry)
      return [system, ...entry.tags.filter(tag => !AUTO_TAGS.includes(tag))]
    }

    /**
     * Tag inventory derived from loaded entries, used until the Host half
     * reports its own.
     * @param {Record<string, any>[]} entries - Loaded entries.
     * @returns {{ tag: string, count: number, system: boolean }[]} Inventory.
     */
    function deriveTagInventory(entries) {
      /** @type {Map<string, number>} */
      const counts = new Map(AUTO_TAGS.map(tag => [tag, 0]))
      for (const entry of entries) {
        for (const tag of tagsOf(entry)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
      return [...counts.entries()]
        .map(([tag, count]) => ({ tag, count, system: AUTO_TAGS.includes(tag) }))
        .sort((left, right) => (right.count - left.count)
          || (Number(right.system) - Number(left.system))
          || (left.tag < right.tag ? -1 : 1))
    }

    /**
     * Wrap every occurrence of the search terms in a mark element.
     * @param {string} text - Plain text.
     * @param {string[]} terms - Lowercased terms.
     * @returns {unknown} A text node, or an array of text and mark nodes.
     */
    function highlighted(text, terms) {
      const source = String(text ?? '')
      if (terms.length === 0) return source
      const lower = source.toLowerCase()
      /** @type {{ start: number, end: number }[]} */
      const spans = []
      for (const term of terms) {
        let from = lower.indexOf(term)
        while (from >= 0) {
          spans.push({ start: from, end: from + term.length })
          from = lower.indexOf(term, from + term.length)
        }
      }
      if (spans.length === 0) return source
      spans.sort((left, right) => left.start - right.start || right.end - left.end)
      /** @type {unknown[]} */
      const nodes = []
      let cursor = 0
      for (const span of spans) {
        if (span.start < cursor) continue
        if (span.start > cursor) nodes.push(source.slice(cursor, span.start))
        nodes.push(h('mark', { key: `m${String(span.start)}`, className: 'dsmv-mark' }, source.slice(span.start, span.end)))
        cursor = span.end
      }
      if (cursor < source.length) nodes.push(source.slice(cursor))
      return nodes
    }

    /**
     * One single-line preview of a memory body, with the shell's own Markdown
     * extraction so code fences, tables and math reduce to their text.
     * @param {string} source - Markdown source.
     * @param {number} limit - Maximum characters.
     * @returns {string} A one-line preview.
     */
    function plainPreview(source, limit) {
      const text = extractMarkdownPlainText(String(source ?? '')).replace(/\s+/g, ' ').trim()
      return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
    }

    /**
     * Format one epoch millisecond value for display.
     * @param {number} value - Epoch milliseconds.
     * @returns {string} `YYYY-MM-DD HH:mm`, or an empty string for a missing value.
     */
    function stamp(value) {
      if (typeof value !== 'number' || value <= 0) return ''
      const date = new Date(value)
      const pad = (part) => String(part).padStart(2, '0')
      return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * The tone one tag renders with, so provenance reads at a glance.
     * @param {string} tag - Tag text.
     * @param {boolean} active - Whether the tag currently filters the board.
     * @returns {string} A `Tag` tone.
     */
    function tagTone(tag, active) {
      if (tag === 'AI自动总结') return 'info'
      if (tag === '人工输入') return 'success'
      return active ? 'solid' : 'outline'
    }

    /**
     * A clickable, color-coded tag badge. `Tag` is the shell's read-only badge,
     * so the click target is the wrapper — which keeps the tone vocabulary
     * (provenance colors) that a plain `Pill` cannot carry.
     * @param {Record<string, any>} props - Badge props.
     * @returns {unknown} React element.
     */
    function TagButton({ tag, active, onClick, title, children }) {
      return h('span', {
        className: `dsmv-tagbtn${active === true ? ' dsmv-tagbtn--active' : ''}`,
        role: 'button',
        tabIndex: 0,
        'aria-pressed': active === true,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onClick()
        },
        onClick: (event) => { event.stopPropagation(); onClick() },
        title,
      }, children ?? h(Tag, { tone: tagTone(tag, active === true) }, tag))
    }

    /**
     * Render one entry's tag row.
     * @param {Record<string, any>} entry - Entry view.
     * @param {string[]} activeTags - Tags currently filtering the board.
     * @param {(tag: string) => void} onTag - Tag click handler.
     * @param {number} max - Maximum tags rendered.
     * @returns {unknown} React element.
     */
    function TagRow({ entry, activeTags, onTag, max }) {
      const all = tagsOf(entry)
      const shown = all.slice(0, max)
      const rest = all.length - shown.length
      return h('div', { className: 'dsmv-tile-tags' },
        ...shown.map(tag => h(TagButton, {
          key: tag,
          tag,
          active: activeTags.includes(tag),
          onClick: () => { onTag(tag) },
        })),
        rest <= 0 ? null : h('span', { className: 'dsmv-cap' }, `+${String(rest)}`),
      )
    }

    /**
     * One tile of the board: a title, a one-paragraph preview, its tags, where
     * it lives, and the actions that belong to the tile rather than to its
     * detail screen. In selection mode the whole tile is the hit target, so a
     * stray press never opens a memory the reader meant to tick.
     * @param {Record<string, any>} props - Tile props.
     * @returns {unknown} React element.
     */
    function Tile({
      entry, terms, activeTags, onTag, onOpen, onScope, onHide, onRestore, onDelete,
      selecting, selected, onSelect, canHide, t,
    }) {
      const title = entry.title === '' ? plainPreview(entry.content, 60) : entry.title
      const classes = ['dsmv-tile']
      if (entry.hidden === true) classes.push('dsmv-tile--hidden')
      if (selected === true) classes.push('dsmv-tile--sel')
      /** What activating the tile means: tick it while selecting, open it otherwise. */
      const activate = () => { if (selecting === true) onSelect(entry.id); else onOpen(entry.id) }
      return h('div', {
        className: classes.join(' '),
        draggable: selecting !== true,
        // A tile is a control, so it has to be reachable and operable without a
        // pointer: a role, a tab stop, and the keys a button answers to.
        role: 'button',
        tabIndex: 0,
        'aria-pressed': selecting === true ? selected === true : undefined,
        'aria-label': title,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          activate()
        },
        onDragStart: (event) => {
          event.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'entry', id: entry.id }))
          event.dataTransfer.effectAllowed = 'move'
        },
        onClick: activate,
      },
        selecting === true
          ? h('span', { className: selected === true ? 'dsmv-check dsmv-check--on' : 'dsmv-check' },
              selected === true ? h(IconCheckOutlineMedium, null) : null)
          : null,
        h('div', { className: 'dsmv-tile-title' }, highlighted(title, terms)),
        h('div', { className: 'dsmv-tile-body' }, highlighted(plainPreview(entry.content, 220), terms)),
        h(TagRow, { entry, activeTags, onTag, max: 4 }),
        h('div', { className: 'dsmv-tile-foot' },
          entry.hidden === true ? h(Tag, { tone: 'warning' }, t('hidden')) : null,
          Number(entry.priority ?? 0) > 0
            ? h(Tag, { tone: 'info', title: t('priorityHint') }, `${t('priorityShort')}${String(entry.priority)}`)
            : null,
          entry.base === true
            ? h(Tag, { tone: 'success', title: t('baseHint') }, t('baseBadge'))
            : null,
          selecting === true
            ? h(Tag, null, entry.scope === 'knowledge' ? t('scopeShortKnowledge') : t('scopeShortConversation'))
            : h('span', { className: 'dsmv-seg' },
                h(Pill, {
                  active: entry.scope === 'conversation',
                  title: t('moveToConversation'),
                  onClick: (event) => { event.stopPropagation(); onScope(entry, 'conversation') },
                }, t('scopeShortConversation')),
                h(Pill, {
                  active: entry.scope === 'knowledge',
                  title: t('moveToKnowledge'),
                  onClick: (event) => { event.stopPropagation(); onScope(entry, 'knowledge') },
                }, t('scopeShortKnowledge')),
              ),
          h('span', null, entry.groupName ?? entry.groupId),
          h('span', { className: 'dsmv-spacer' }),
          selecting === true
            ? h('span', null, stamp(entry.updatedAt))
            : entry.hidden === true
              ? h(Button, {
                  size: 'sm',
                  icon: h(IconArchiveOffOutlineMedium, null),
                  title: t('hideHint'),
                  onClick: (event) => { event.stopPropagation(); onRestore(entry.id) },
                }, t('unhide'))
              : h('span', { className: 'dsmv-seg' },
                  h(Button, {
                    size: 'sm',
                    icon: h(IconTrashOutlineMedium, null),
                    title: t('remove'),
                    onClick: (event) => { event.stopPropagation(); onDelete(entry) },
                  }),
                  h(Button, {
                    size: 'sm',
                    icon: h(IconArchiveOutlineMedium, null),
                    title: canHide === true ? t('hideHint') : t('hideNeedsRestart'),
                    onClick: (event) => { event.stopPropagation(); onHide(entry.id) },
                  }, t('hide')),
                ),
        ),
      )
    }

    /**
     * A collapsible section of tiles.
     * @param {Record<string, any>} props - Section props.
     * @returns {unknown} React element.
     */
    function Section({ label, count, unit, children, open }) {
      return h('details', { className: 'dsmv-sec', open: open !== false },
        h('summary', null,
          h('span', null, label),
          h('span', { className: 'dsmv-cap' }, `${String(count)} ${unit}`),
        ),
        h('div', { className: 'dsmv-sec-body' }, children),
      )
    }

    /**
     * The management page: the tile board and its detail level.
     * @param {Record<string, any>} props - Slot props carrying the bound dictionary.
     * @returns {unknown} React element.
     */
    function MemoryVaultPage(props) {
      const t = props.t
      const markdownLabels = props.markdownLabels ?? MARKDOWN_LABELS.zh
      const [state, setState] = React.useState(null)
      const [entries, setEntries] = React.useState([])
      const [query, setQuery] = React.useState('')
      const [activeTags, setActiveTags] = React.useState([])
      const [scopeFilter, setScopeFilter] = React.useState('all')
      const [includeHidden, setIncludeHidden] = React.useState(false)
      const [groupBy, setGroupBy] = React.useState('group')
      const [view, setView] = React.useState({ kind: 'list' })
      const [over, setOver] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [selecting, setSelecting] = React.useState(false)
      const [selected, setSelected] = React.useState([])
      const [bulkTag, setBulkTag] = React.useState('')
      // Hiding arrived with a later Host half. Until the process is restarted the
      // vault reports no hidden count, and every hide affordance stays inert
      // instead of failing a call the running Host cannot serve.
      const [canHide, setCanHide] = React.useState(null)
      const [hasMore, setHasMore] = React.useState(false)
      const [loaded, setLoaded] = React.useState(0)

      const terms = termsOf(query)

      /**
       * Read one page of the board.
       *
       * Every facet the bar offers is sent to the server — several tags mean
       * their intersection — so filtering never happens over only the rows that
       * happen to be loaded.
       * @param {number} offset - Rows to skip.
       * @returns {Promise<Record<string, any>>} The page.
       */
      const requestPage = React.useCallback((offset) => call('entries', {
        query,
        tag: activeTags.length === 0 ? undefined : activeTags,
        includeHidden,
        limit: PAGE_LIMIT,
        offset,
      }), [query, activeTags, includeHidden])

      const load = React.useCallback(async () => {
        try {
          const [next, listed] = await Promise.all([call('state'), requestPage(0)])
          setState(next)
          setEntries(listed.entries)
          setLoaded(listed.entries.length)
          setHasMore(listed.hasMore === true)
          setCanHide(next.stats?.hidden !== undefined)
          setError(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [requestPage])

      /** Append the next page, so a large vault stays fully reachable. */
      const loadMore = async () => {
        try {
          const listed = await requestPage(loaded)
          setEntries(current => [...current, ...listed.entries])
          setLoaded(current => current + listed.entries.length)
          setHasMore(listed.hasMore === true)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }

      React.useEffect(() => { void load() }, [load])

      React.useEffect(() => {
        const timer = window.setInterval(() => {
          if (document.visibilityState === 'visible') void load()
        }, POLL_MS)
        return () => { window.clearInterval(timer) }
      }, [load])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          // Escape unwinds one level at a time: selection first, then the
          // detail screen, so a reader never loses both at once.
          if (selecting) {
            setSelecting(false)
            setSelected([])
            return
          }
          if (view.kind !== 'list') setView({ kind: 'list' })
        }
        window.addEventListener('keydown', onKey)
        return () => { window.removeEventListener('keydown', onKey) }
      }, [view, selecting])

      /**
       * Run one mutating call, then refresh.
       * @param {() => Promise<unknown>} action - Operation to run.
       * @param {string} [success] - Notice shown on success.
       * @returns {Promise<boolean>} Whether the operation succeeded.
       */
      const mutate = async (action, success) => {
        setBusy(true)
        try {
          await action()
          await load()
          setError(null)
          setNotice(success ?? null)
          return true
        } catch (failure) {
          setNotice(null)
          setError(failure instanceof Error ? failure.message : String(failure))
          return false
        } finally {
          setBusy(false)
        }
      }

      const toggleTag = (tag) => {
        setActiveTags(current => current.includes(tag)
          ? current.filter(entry => entry !== tag)
          : [...current, tag])
      }
      const assign = (ids, scope) => mutate(() => call('assign', undefined, { ids, scope }))
      const assignGroup = (group, scope) => mutate(() => call('assign', undefined, { group: group.id, scope }))

      /**
       * Hide or restore entries. A Host half from before hiding existed cannot
       * serve the call, so the press explains itself there instead of failing —
       * a refusal the reader can read beats a button that looks broken.
       * @param {string[]} ids - Entry ids.
       * @param {boolean} hidden - Target visibility.
       * @returns {Promise<boolean>} Whether the vault changed.
       */
      const setHidden = (ids, hidden) => {
        if (canHide !== true) {
          setError(null)
          setNotice(t('hideNeedsRestart'))
          return Promise.resolve(false)
        }
        return mutate(
          () => call('entry.hide', undefined, { ids, hidden }),
          hidden ? t('hideHint') : t('saved'),
        )
      }

      /**
       * Read or write a bulk action's result. Every bulk operation is a loop
       * over the single-entry operations the vault already serves, so the
       * board's actions need no second write path of their own.
       * @param {string[]} ids - Entry ids.
       * @param {(id: string) => Promise<unknown>} step - One entry's call.
       * @returns {Promise<void>} Resolution after every step.
       */
      const forEachId = async (ids, step) => {
        for (const id of ids) await step(id)
      }

      const clearSelection = () => {
        setSelecting(false)
        setSelected([])
        setBulkTag('')
      }
      const toggleSelected = (id) => {
        setSelected(current => (current.includes(id) ? current.filter(item => item !== id) : [...current, id]))
      }

      /**
       * Apply one tag to every selected memory.
       * @returns {Promise<void>} Resolution after the reload.
       */
      const bulkAddTag = async () => {
        const tag = bulkTag.trim()
        if (tag === '' || selected.length === 0) return
        const targets = entries.filter(entry => selected.includes(entry.id))
        const done = await mutate(
          () => forEachId(targets, entry => call('entry.update', undefined, {
            id: entry.id,
            tags: [...new Set([...tagsOf(entry), tag])],
          })),
          t('saved'),
        )
        if (done) setBulkTag('')
      }

      /**
       * Delete every selected memory after one confirmation.
       * @returns {Promise<void>} Resolution after the reload.
       */
      const bulkDelete = async () => {
        if (selected.length === 0) return
        if (!window.confirm(t('bulkDeleteConfirm'))) return
        const done = await mutate(
          () => forEachId([...selected], id => call('entry.delete', undefined, { id })),
          t('saved'),
        )
        if (done) clearSelection()
      }

      /**
       * Add one tag to a memory by dragging it onto that tag's facet.
       * @param {Record<string, any>} entry - Entry to label.
       * @param {string} tag - Tag to add.
       * @returns {void}
       */
      const addTag = (entry, tag) => {
        void mutate(() => call('entry.update', undefined, {
          id: entry.id,
          tags: [...new Set([...tagsOf(entry), tag])],
        }), t('saved'))
      }

      /**
       * Route one drop onto a facet: a scope facet reassigns, a tag facet labels.
       * @param {DragEvent} event - Drop event.
       * @param {Record<string, any>} target - Drop target description.
       * @returns {void}
       */
      const onDrop = (event, target) => {
        event.preventDefault()
        setOver(null)
        let payload
        try {
          payload = JSON.parse(event.dataTransfer.getData('text/plain'))
        } catch (_error) {
          // A drag from outside this page carries no vault payload; ignore it.
          return
        }
        if (payload?.kind === 'group' && typeof payload.id === 'string' && target.kind === 'scope') {
          void mutate(() => call('assign', undefined, { group: payload.id, scope: target.scope }))
          return
        }
        if (payload?.kind !== 'entry' || typeof payload.id !== 'string') return
        if (target.kind === 'scope') {
          void assign([payload.id], target.scope)
          return
        }
        const entry = entries.find(item => item.id === payload.id)
        if (entry !== undefined && !tagsOf(entry).includes(target.tag)) addTag(entry, target.tag)
      }

      const groups = state?.groups ?? []
      const allTags = state?.tags ?? deriveTagInventory(entries)
      const stats = state?.stats
      const scopeFiltered = scopeFilter === 'all' ? entries : entries.filter(entry => entry.scope === scopeFilter)
      const visible = scopeFiltered.filter(entry => activeTags.every(tag => tagsOf(entry).includes(tag)))

      /** Render the detail level for one memory, or the create level. */
      if (view.kind === 'detail' || view.kind === 'create') {
        return h('div', { className: 'dsmv' },
          h(StyleSheet),
          h(DetailLevel, {
            t,
            markdownLabels,
            view,
            groups,
            busy,
            error,
            notice,
            canHide,
            onToggleHide: (target) => setHidden([target.id], target.hidden !== true),
            setView,
            mutate,
            entry: view.kind === 'detail' ? entries.find(item => item.id === view.id) : undefined,
          }),
        )
      }

      /**
       * Group the visible tiles for display.
       * @param {Record<string, any>[]} rows - Tiles of the board.
       * @returns {{ key: string, label: string, rows: Record<string, any>[] }[]} Sections in display order.
       */
      const sectionsFor = (rows) => {
        if (groupBy === 'none') return [{ key: 'all', label: t('entries'), rows }]
        /** @type {Map<string, Record<string, any>[]>} */
        const buckets = new Map()
        for (const row of rows) {
          const keys = groupBy === 'tag' ? tagsOf(row) : [row.groupName ?? row.groupId]
          for (const key of keys) {
            if (!buckets.has(key)) buckets.set(key, [])
            buckets.get(key).push(row)
          }
        }
        const rank = new Map(allTags.map((item, index) => [item.tag, index]))
        const order = groupBy === 'tag'
          ? [...buckets.keys()].sort((left, right) =>
              (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER))
          : [...buckets.keys()].sort((left, right) => (left < right ? -1 : 1))
        return order.map(key => ({ key, label: key, rows: buckets.get(key) }))
      }

      const sections = sectionsFor(visible)

      /**
       * One scope facet: both a filter and the drop target that reassigns.
       * @param {string} value - `all`, `conversation`, or `knowledge`.
       * @param {string} label - Facet label.
       * @param {number} count - Tiles in this scope.
       * @returns {unknown} React element.
       */
      const scopeFacet = (value, label, count) => {
        const target = { kind: 'scope', scope: value, id: `scope:${value}` }
        return h(Pill, {
          key: `scope-${value}`,
          active: scopeFilter === value,
          onClick: () => { setScopeFilter(value) },
          onDragOver: (event) => { event.preventDefault(); setOver(target.id) },
          onDragLeave: () => { setOver(current => (current === target.id ? null : current)) },
          onDrop: (event) => { onDrop(event, target) },
          style: over === target.id ? { outline: '2px dashed var(--dsw-alias-link)', outlineOffset: '2px' } : undefined,
        }, `${label} ${String(count)}`)
      }

      return h('div', { className: 'dsmv' },
        h(StyleSheet),
        h('div', { className: 'dsmv-scroll' },
          h('div', { className: 'dsmv-head' },
            h('div', { className: 'dsmv-col', style: { gap: '2px', flex: '1 1 auto' } },
              h('h2', { className: 'dsmv-title' }, t('title')),
              h('div', { className: 'dsmv-sub' }, t('subtitle')),
              stats === undefined ? null : h('div', { className: 'dsmv-cap' },
                `${String(stats.totals.groups)} ${t('groupCount')} · ${String(stats.totals.entries)} ${t('entries')}`
                + ` · ${t('conversation')} ${String(stats.entries.conversation)} · ${t('knowledge')} ${String(stats.entries.knowledge)}`
                + (stats.hidden > 0 ? ` · ${t('hidden')} ${String(stats.hidden)}` : '')
                + (state?.apply === undefined
                  ? ''
                  : ` · ${t('applyDefaultNote')} ${state.apply.defaults.length === 0 ? t('applyNone') : state.apply.defaults.join('、')}`)),
            ),
          ),

          h('div', { className: 'dsmv-bar' },
            h('div', { style: { flex: '1 1 260px', maxWidth: '360px' } },
              h(Input, {
                icon: h(IconSearchOutlineMedium, null),
                value: query,
                placeholder: t('search'),
                onChange: (event) => { setQuery(event.target.value) },
              }),
            ),
            query === '' ? null : h(Button, { onClick: () => { setQuery('') } }, t('clear')),
            h(Button, {
              variant: 'primary',
              icon: h(IconPlusOutlineMedium, null),
              onClick: () => { setNotice(null); setView({ kind: 'create' }) },
            }, t('newEntry')),
            h(Button, {
              icon: h(IconRefreshOutlineMedium, null),
              disabled: busy,
              onClick: () => { void load() },
            }, t('refresh')),
            h(Button, {
              icon: h(IconChecklistOutlineMedium, null),
              variant: selecting ? 'outline' : 'ghost',
              onClick: () => {
                if (selecting) clearSelection()
                else setSelecting(true)
              },
            }, selecting ? t('exitSelect') : t('select')),
          ),

          // The facet bar is the board's filter and its drop surface: a scope
          // facet reassigns a dragged tile, a tag facet labels it.
          h('div', { className: 'dsmv-facets' },
            h('span', { className: 'dsmv-cap' }, t('facets')),
            scopeFacet('all', t('all'), entries.length),
            scopeFacet('knowledge', t('knowledge'), entries.filter(entry => entry.scope === 'knowledge').length),
            scopeFacet('conversation', t('conversation'), entries.filter(entry => entry.scope === 'conversation').length),
            h('span', { className: 'dsmv-cap', style: { marginLeft: '6px' } }, t('tags')),
            ...allTags.map(item => {
              const target = { kind: 'tag', tag: item.tag, id: `tag:${item.tag}` }
              const active = activeTags.includes(item.tag)
              return h(TagButton, {
                key: item.tag,
                tag: item.tag,
                active,
                onClick: () => { toggleTag(item.tag) },
                title: item.tag,
              }, h('span', {
                onDragOver: (event) => { event.preventDefault(); setOver(target.id) },
                onDragLeave: () => { setOver(current => (current === target.id ? null : current)) },
                onDrop: (event) => { onDrop(event, target) },
                style: over === target.id
                  ? { outline: '2px dashed var(--dsw-alias-link)', outlineOffset: '2px', borderRadius: '999px' }
                  : undefined,
              }, h(Tag, { tone: tagTone(item.tag, active) }, `${item.tag} ${String(item.count)}`)))
            }),
            activeTags.length === 0 ? null : h(Button, { size: 'sm', onClick: () => { setActiveTags([]) } }, t('clear')),
            h('span', { className: 'dsmv-spacer' }),
            h(Switch, {
              checked: includeHidden,
              onChange: setIncludeHidden,
              label: `${t('showHidden')} ${String(stats?.hidden ?? 0)}`,
              title: t('hideHint'),
            }),
            h('span', { className: 'dsmv-cap' }, t('groupBy')),
            h(Pill, { active: groupBy === 'group', onClick: () => { setGroupBy('group') } }, t('groupByGroup')),
            h(Pill, { active: groupBy === 'tag', onClick: () => { setGroupBy('tag') } }, t('groupByTag')),
            h(Pill, { active: groupBy === 'none', onClick: () => { setGroupBy('none') } }, t('groupByNone')),
          ),

          h('details', { className: 'dsmv-sec' },
            h('summary', null,
              h('span', null, t('groups')),
              h('span', { className: 'dsmv-cap' }, `${String(groups.length)} ${t('groupCount')}`),
            ),
            h('div', { className: 'dsmv-sec-body' },
              groups.map(group => h('div', {
                key: group.id,
                className: 'dsmv-row',
                draggable: true,
                onDragStart: (event) => {
                  event.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'group', id: group.id }))
                  event.dataTransfer.effectAllowed = 'move'
                },
              },
                h('strong', { style: { fontSize: '13px' } }, group.name),
                h(Tag, null, group.scope === 'knowledge' ? t('knowledge') : t('conversation')),
                h('span', { className: 'dsmv-cap' }, `${String(group.entryCount)} ${t('entries')}`),
                h('span', { className: 'dsmv-cap' }, `${t('priorityLabel')} P${String(group.priority ?? 0)}`),
                h(Button, {
                  size: 'sm',
                  title: t('priorityHint'),
                  disabled: Number(group.priority ?? 0) <= 0,
                  onClick: () => {
                    void mutate(() => call('group.update', undefined, {
                      id: group.id,
                      priority: Math.max(0, Number(group.priority ?? 0) - 10),
                    }))
                  },
                }, '−'),
                h(Button, {
                  size: 'sm',
                  title: t('priorityHint'),
                  disabled: Number(group.priority ?? 0) >= 100,
                  onClick: () => {
                    void mutate(() => call('group.update', undefined, {
                      id: group.id,
                      priority: Math.min(100, Number(group.priority ?? 0) + 10),
                    }))
                  },
                }, '+'),
                group.description === '' ? null : h('span', { className: 'dsmv-cap' }, group.description),
                h('span', { className: 'dsmv-spacer' }),
                h(Button, {
                  size: 'sm',
                  title: group.autoSummary ? t('autoSummaryOn') : t('autoSummaryOff'),
                  onClick: () => {
                    void mutate(() => call('group.update', undefined, { id: group.id, autoSummary: !group.autoSummary }))
                  },
                }, `${t('autoSummary')} ${group.autoSummary ? '●' : '○'}`),
                h(Button, {
                  size: 'sm',
                  onClick: () => {
                    void assignGroup(group, group.scope === 'knowledge' ? 'conversation' : 'knowledge')
                  },
                }, t('flip')),
                h(Button, {
                  size: 'sm',
                  icon: h(IconTrashOutlineMedium, null),
                  onClick: () => {
                    if (window.confirm(t('removeGroupConfirm'))) {
                      void mutate(() => call('group.delete', undefined, { id: group.id }))
                    }
                  },
                }, t('remove')),
              )),
              h(GroupCreator, { t, busy, mutate }),
            ),
          ),

          error === null ? null : h('div', { className: 'dsmv-error' }, error),
          notice === null ? null : h('div', { className: 'dsmv-ok' }, notice),

          sections.length === 0 || visible.length === 0
            ? h('div', { className: 'dsmv-empty' }, entries.length === 0 ? t('boardEmpty') : t('emptyFiltered'))
            : sections.map(section => h(Section, {
                key: section.key,
                label: section.label,
                count: section.rows.length,
                unit: t('entries'),
                open: groupBy !== 'group' || sections.length <= 3,
              }, h('div', { className: 'dsmv-board' }, section.rows.map(entry => h(Tile, {
                key: entry.id,
                entry,
                terms,
                activeTags,
                t,
                selecting,
                selected: selected.includes(entry.id),
                canHide,
                onSelect: toggleSelected,
                onTag: toggleTag,
                onScope: (target, scope) => { void assign([target.id], scope) },
                onHide: (id) => { void setHidden([id], true) },
                onRestore: (id) => { void setHidden([id], false) },
                onDelete: (target) => {
                  if (!window.confirm(t('removeEntryConfirm'))) return
                  void mutate(() => call('entry.delete', undefined, { id: target.id }))
                },
                onOpen: (id) => { setNotice(null); setView({ kind: 'detail', id }) },
              }))))),

          hasMore
            ? h('div', { className: 'dsmv-row' },
                h(Button, {
                  size: 'sm',
                  icon: h(IconRefreshOutlineMedium, null),
                  disabled: busy,
                  onClick: () => { void loadMore() },
                }, `${t('loadMore')}（${String(loaded)}）`),
              )
            : null,

          selecting
            ? h('div', { className: 'dsmv-actionbar' },
                h('strong', { style: { fontSize: 'var(--dsmv-fs-small)' } },
                  `${t('selectedCount')} ${String(selected.length)}`),
                h(Button, {
                  size: 'sm',
                  disabled: selected.length === 0,
                  onClick: () => { setSelected(visible.map(entry => entry.id)) },
                }, t('selectAll')),
                h(Button, {
                  size: 'sm',
                  disabled: selected.length === 0,
                  onClick: () => { setSelected([]) },
                }, t('selectNone')),
                h('span', { className: 'dsmv-spacer' }),
                h('div', { style: { width: '150px' } },
                  h(Input, {
                    value: bulkTag,
                    placeholder: t('bulkTagPlaceholder'),
                    onChange: (event) => { setBulkTag(event.target.value) },
                    onKeyDown: (event) => { if (event.key === 'Enter') void bulkAddTag() },
                  }),
                ),
                h(Button, {
                  size: 'sm',
                  disabled: selected.length === 0 || bulkTag.trim() === '' || busy,
                  onClick: () => { void bulkAddTag() },
                }, t('bulkTag')),
                h(Button, {
                  size: 'sm',
                  icon: h(IconArchiveOutlineMedium, null),
                  disabled: selected.length === 0 || busy,
                  title: canHide === true ? t('hideHint') : t('hideNeedsRestart'),
                  onClick: () => { void setHidden([...selected], true).then(ok => { if (ok) clearSelection() }) },
                }, t('hide')),
                h(Button, {
                  size: 'sm',
                  icon: h(IconContextInjectionOutlineMedium, null),
                  disabled: selected.length === 0 || busy,
                  onClick: () => { void assign([...selected], 'knowledge').then(ok => { if (ok) clearSelection() }) },
                }, t('knowledge')),
                h(Button, {
                  size: 'sm',
                  icon: h(IconContextInjectionOutlineMedium, null),
                  disabled: selected.length === 0 || busy,
                  onClick: () => { void assign([...selected], 'conversation').then(ok => { if (ok) clearSelection() }) },
                }, t('conversation')),
                h(Button, {
                  size: 'sm',
                  icon: h(IconTrashOutlineMedium, null),
                  disabled: selected.length === 0 || busy,
                  onClick: () => { void bulkDelete() },
                }, t('remove')),
                h(Button, { size: 'sm', onClick: clearSelection }, t('bulkClear')),
              )
            : null,

          h('div', { className: 'dsmv-cap' }, t('tileHint')),
          state === null ? h('div', { className: 'dsmv-empty' }, t('loading')) : null,
        ),
      )
    }

    /**
     * The inline new-group form.
     * @param {Record<string, any>} props - Creator props.
     * @returns {unknown} React element.
     */
    function GroupCreator({ t, busy, mutate }) {
      const [open, setOpen] = React.useState(false)
      const [name, setName] = React.useState('')
      const [scope, setScope] = React.useState('conversation')
      if (!open) {
        return h('div', { className: 'dsmv-row' },
          h(Button, { size: 'sm', icon: h(IconPlusOutlineMedium, null), onClick: () => { setOpen(true) } }, t('newGroup')),
        )
      }
      return h('div', { className: 'dsmv-row' },
        h('div', { style: { width: '180px' } },
          h(Input, {
            value: name,
            placeholder: t('groupName'),
            onChange: (event) => { setName(event.target.value) },
          }),
        ),
        h(Pill, { active: scope === 'conversation', onClick: () => { setScope('conversation') } }, t('conversation')),
        h(Pill, { active: scope === 'knowledge', onClick: () => { setScope('knowledge') } }, t('knowledge')),
        h(Button, {
          variant: 'primary',
          size: 'sm',
          disabled: busy || name.trim() === '',
          onClick: () => {
            void mutate(() => call('group.create', undefined, { name: name.trim(), scope }))
              .then((ok) => { if (ok) { setName(''); setOpen(false) } })
          },
        }, t('create')),
        h(Button, { size: 'sm', onClick: () => { setOpen(false); setName('') } }, t('cancel')),
      )
    }

    /**
     * The second level: one memory in full, editable in place, or the form that
     * creates a new one.
     * @param {Record<string, any>} props - Detail props.
     * @returns {unknown} React element.
     */
    function DetailLevel({
      t, markdownLabels, view, groups, busy, error, notice, canHide, onToggleHide, setView, mutate, entry,
    }) {
      const creating = view.kind === 'create'
      const [editing, setEditing] = React.useState(creating)
      const [showSource, setShowSource] = React.useState(false)
      const [title, setTitle] = React.useState('')
      const [content, setContent] = React.useState('')
      const [kind, setKind] = React.useState('note')
      const [tagDraft, setTagDraft] = React.useState('')
      const [tags, setTags] = React.useState([])
      const [scope, setScope] = React.useState('conversation')
      const [groupRef, setGroupRef] = React.useState('')

      // The row can be replaced by a poll between renders; re-seed the editor
      // only when the identity or the stored revision changes.
      const revision = entry === undefined ? `new:${String(view.kind)}` : `${entry.id}:${String(entry.updatedAt)}`
      const [seeded, setSeeded] = React.useState(null)
      if (seeded !== revision) {
        setSeeded(revision)
        setEditing(creating)
        setTitle(entry?.title ?? '')
        setContent(entry?.content ?? '')
        setKind(entry?.kind ?? 'note')
        setScope(entry?.scope ?? 'conversation')
        setGroupRef(entry?.groupId ?? (groups[0]?.id ?? ''))
        setTags(entry === undefined ? [] : entry.tags.filter(tag => !AUTO_TAGS.includes(tag)))
        setTagDraft('')
      }

      const back = () => { setView({ kind: 'list' }) }
      const commit = async () => {
        // The system tag rides along so an older Host half — one that has not
        // been restarted since system tags were introduced — stores it too
        // instead of dropping a tag it does not yet manage itself.
        const ok = creating
          ? await mutate(() => call('entry.write', undefined, {
              groupId: groupRef,
              content,
              title,
              kind,
              tags: [...tags, '人工输入'],
              scope,
            }), t('created'))
          : await mutate(() => call('entry.update', undefined, {
              id: entry.id,
              title,
              content,
              kind,
              tags: [...tags, autoTagOf(entry)],
            }), t('saved'))
        if (ok) setEditing(false)
      }

      if (!creating && entry === undefined) {
        return h('div', { className: 'dsmv-scroll' },
          h('div', { className: 'dsmv-bar' },
            h(Button, { icon: h(IconChevronLeftOutlineMedium, null), onClick: back }, t('back')),
          ),
          h('div', { className: 'dsmv-empty' }, t('missing')),
        )
      }

      const headerTitle = creating ? t('newEntry') : (entry.title === '' ? plainPreview(entry.content, 60) : entry.title)
      return h('div', { className: 'dsmv-scroll' },
        h('div', { className: 'dsmv-bar' },
          h(Button, { icon: h(IconChevronLeftOutlineMedium, null), onClick: back }, t('back')),
          h('span', { className: 'dsmv-cap' },
            `${t('title')} / ${creating ? t('newEntry') : (entry.groupName ?? entry.groupId)} / ${headerTitle}`),
          h('span', { className: 'dsmv-spacer' }),
          creating || editing
            ? h(Button, { variant: 'primary', disabled: busy || content.trim() === '', onClick: () => { void commit() } }, t('save'))
            : h(Button, { onClick: () => { setEditing(true) } }, t('edit')),
          creating || editing
            ? h(Button, { onClick: () => { if (creating) back(); else setEditing(false) } }, t('cancel'))
            : null,
          creating ? null : h(Button, {
            icon: entry.hidden === true ? h(IconArchiveOffOutlineMedium, null) : h(IconArchiveOutlineMedium, null),
            title: canHide === true ? t('hideHint') : t('hideNeedsRestart'),
            onClick: () => { void onToggleHide(entry) },
          }, entry.hidden === true ? t('unhide') : t('hide')),
          creating ? null : h(Button, {
            icon: h(IconTrashOutlineMedium, null),
            onClick: () => {
              if (window.confirm(t('removeEntryConfirm'))) {
                void mutate(() => call('entry.delete', undefined, { id: entry.id })).then((ok) => { if (ok) back() })
              }
            },
          }, t('remove')),
        ),

        error === null ? null : h('div', { className: 'dsmv-error' }, error),
        notice === null ? null : h('div', { className: 'dsmv-ok' }, notice),

        h('div', { className: 'dsmv-card' },
          creating || editing
            ? h('div', { className: 'dsmv-row' },
                h('div', { style: { flex: '1 1 280px' } },
                  h(Input, {
                    value: title,
                    placeholder: t('titleField'),
                    onChange: (event) => { setTitle(event.target.value) },
                  }),
                ),
                h('span', { className: 'dsmv-cap' }, t('kindField')),
                ...KINDS.map(([value, label]) => h(Pill, {
                  key: value,
                  active: kind === value,
                  onClick: () => { setKind(value) },
                }, label)),
              )
            : h('h3', { style: { margin: 0, fontSize: '15px', fontWeight: 600, lineHeight: '22px' } },
                entry.title === '' ? t('untitled') : entry.title),

          creating
            ? h('div', { className: 'dsmv-row' },
                h('span', { className: 'dsmv-cap' }, t('groupField')),
                ...groups.map(group => h(Pill, {
                  key: group.id,
                  active: groupRef === group.id,
                  onClick: () => { setGroupRef(group.id) },
                }, group.name)),
                h('span', { className: 'dsmv-cap', style: { marginLeft: '6px' } }, t('scopeField')),
                h(Pill, { active: scope === 'conversation', onClick: () => { setScope('conversation') } }, t('conversation')),
                h(Pill, { active: scope === 'knowledge', onClick: () => { setScope('knowledge') } }, t('knowledge')),
              )
            : null,

          h('div', { className: 'dsmv-row' },
            h('span', { className: 'dsmv-cap' }, t('tags')),
            h(Tag, { tone: autoTagOf(entry ?? { source: 'manual' }) === 'AI自动总结' ? 'info' : 'success' },
              entry === undefined ? t('manual') : autoTagOf(entry)),
            ...tags.map(tag => h(TagButton, {
              key: tag,
              tag,
              title: `${t('remove')} ${tag}`,
              onClick: () => { setTags(current => current.filter(item => item !== tag)) },
            }, h(Tag, null, `${tag} ×`))),
            h('div', { style: { width: '150px' } },
              h(Input, {
                value: tagDraft,
                placeholder: t('addTag'),
                onChange: (event) => { setTagDraft(event.target.value) },
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return
                  const next = tagDraft.trim()
                  if (next === '' || AUTO_TAGS.includes(next)) return
                  setTags(current => (current.includes(next) ? current : [...current, next]))
                  setTagDraft('')
                },
              }),
            ),
            h(Button, {
              size: 'sm',
              onClick: () => {
                const next = tagDraft.trim()
                if (next === '' || AUTO_TAGS.includes(next)) return
                setTags(current => (current.includes(next) ? current : [...current, next]))
                setTagDraft('')
              },
            }, t('add')),
          ),

          h('div', { className: 'dsmv-col', style: { gap: '8px' } },
            h('div', { className: 'dsmv-row' },
              h('span', { className: 'dsmv-cap' }, t('content')),
              h('span', { className: 'dsmv-spacer' }),
              creating || editing ? null : h(Button, {
                size: 'sm',
                variant: showSource === true ? 'ghost' : 'outline',
                onClick: () => { setShowSource(false) },
              }, t('preview')),
              creating || editing ? null : h(Button, {
                size: 'sm',
                variant: showSource === true ? 'outline' : 'ghost',
                onClick: () => { setShowSource(true) },
              }, t('source')),
            ),
            creating || editing
              ? h('textarea', {
                  value: content,
                  placeholder: t('content'),
                  onChange: (event) => { setContent(event.target.value) },
                  style: {
                    width: '100%', minHeight: '220px', resize: 'vertical', font: 'inherit', fontSize: '13px',
                    lineHeight: '22px', padding: '10px 12px', color: 'inherit', borderRadius: 'var(--dsw-radius-md)',
                    border: 'none', background: 'var(--dsw-alias-bg-base)',
                    boxShadow: 'inset 0 0 0 1px var(--dsw-alias-settings-card-stroke)',
                  },
                })
              : showSource === true
                ? h('pre', {
                    style: {
                      margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '13px', lineHeight: '22px',
                      fontFamily: 'var(--ds-font-family-code)',
                    },
                  }, entry.content)
                : h(MarkdownText, { text: entry.content, labels: markdownLabels }),
          ),
        ),

        creating ? null : h('div', { className: 'dsmv-card' },
          h('dl', { className: 'dsmv-grid' },
            h('dt', null, t('detailScope')),
            h('dd', null, h(Tag, null, entry.scope === 'knowledge' ? t('knowledge') : t('conversation'))),
            h('dt', null, t('detailGroup')),
            h('dd', null, entry.groupName ?? entry.groupId),
            h('dt', null, t('detailKind')),
            h('dd', null, entry.kind),
            h('dt', null, t('detailSource')),
            h('dd', null, `${entry.source} · ${autoTagOf(entry)}${entry.assigned === 'manual' ? ' · 手动归属' : ''}`),
            h('dt', null, t('visibility')),
            h('dd', null, entry.hidden === true ? h(Tag, { tone: 'warning' }, t('hidden')) : t('visible')),
            h('dt', null, t('priorityLabel')),
            h('dd', null, h('div', { className: 'dsmv-row' },
              ...[0, 40, 70, 90].map(value => h(Pill, {
                key: value,
                active: Number(entry.priority ?? 0) === value,
                title: t('priorityHint'),
                onClick: () => {
                  if (Number(entry.priority ?? 0) === value || busy) return
                  void mutate(() => call('entry.update', undefined, { id: entry.id, priority: value }), t('saved'))
                },
              }, value === 0 ? '0' : `P${String(value)}`)),
              h('span', { className: 'dsmv-cap' }, `当前 P${String(entry.priority ?? 0)}`),
            )),
            h('dt', null, t('baseLabel')),
            h('dd', null, h('div', { className: 'dsmv-row' },
              h(Pill, {
                active: entry.base === true,
                title: t('baseHint'),
                onClick: () => {
                  if (busy) return
                  void mutate(
                    () => call('entry.update', undefined, { id: entry.id, base: entry.base !== true }),
                    t('saved'),
                  )
                },
              }, entry.base === true ? t('baseBadge') : '—'),
              h('span', { className: 'dsmv-cap' }, t('baseHint')),
            )),
            h('dt', null, t('detailCreated')),
            h('dd', null, stamp(entry.createdAt)),
            h('dt', null, t('detailUpdated')),
            h('dd', null, stamp(entry.updatedAt)),
            h('dt', null, t('detailId')),
            h('dd', null, h('code', { style: { fontFamily: 'var(--ds-font-family-code)', fontSize: '12px' } }, entry.id)),
          ),
          h('div', { className: 'dsmv-row' },
            h(Button, {
              size: 'sm',
              variant: 'outline',
              icon: h(IconContextInjectionOutlineMedium, null),
              onClick: () => {
                void mutate(() => call('assign', undefined, {
                  ids: [entry.id],
                  scope: entry.scope === 'knowledge' ? 'conversation' : 'knowledge',
                }), t('saved'))
              },
            }, entry.scope === 'knowledge' ? t('moveToConversation') : t('moveToKnowledge')),
            h('span', { className: 'dsmv-cap' }, t('moveToGroup')),
            ...groups.map(group => h(Pill, {
              key: group.id,
              active: entry.groupId === group.id,
              // Moving a memory into another group adopts that group's
              // assignment, which is what the board already shows.
              onClick: () => {
                if (entry.groupId === group.id) return
                void mutate(() => call('assign', undefined, {
                  ids: [entry.id],
                  targetGroup: group.id,
                  followGroup: true,
                }), t('saved'))
              },
            }, group.name)),
          ),
        ),
      )
    }

    /**
     * The **知识** conversation view.
     *
     * It registers as a `conversation.view` entry, so the shell renders it as a
     * tab beside 对话 and 轨迹 and hands it the whole content area. What
     * knowledge a conversation carries is a decision worth its own panel, and
     * this one answers the second half of the question too: it lists the
     * memories the current selection actually puts in the prompt, rendered the
     * way the model receives them.
     * @param {Record<string, any>} props - Slot props carrying the session id and the bound dictionary.
     * @returns {unknown} React element.
     */
    function KnowledgeView(props) {
      const t = props.t
      const sessionId = props.sessionId
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      // The drop-area highlight is this view's own state; reaching for the
      // board's copy would reference an identifier that is not in scope here.
      const [over, setOver] = React.useState(null)
      const [cure, setCure] = React.useState(null)
      const [curating, setCurating] = React.useState(false)

      const load = React.useCallback(async () => {
        if (sessionId === undefined) return
        try {
          const [applied, vault] = await Promise.all([
            call('apply.get', { sessionId }),
            call('state'),
          ])
          setData({ applied, groups: vault.groups ?? [] })
          setError(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [sessionId])

      React.useEffect(() => { void load() }, [load])

      /**
       * Persist one application choice.
       * @param {string[]|null} next - Group ids, or null to fall back to the deployment default.
       * @returns {Promise<void>} Resolution after the reload.
       */
      const save = async (next) => {
        setBusy(true)
        try {
          await call('apply.set', undefined, { sessionId, groups: next })
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      /**
       * Point this conversation's summaries at one group, or back at the default.
       * @param {string|null} groupId - Target group, or null for the default.
       * @returns {Promise<void>} Resolution after the reload.
       */
      const saveBinding = async (groupId) => {
        setBusy(true)
        try {
          await call('session.bind', undefined, { sessionId, group: groupId })
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      if (sessionId === undefined) return null
      const applied = data?.applied
      const all = data?.groups ?? []
      const appliedIds = new Set((applied?.groups ?? []).map(group => group.id))
      const appliedGroups = all.filter(group => appliedIds.has(group.id))
      const availableGroups = all.filter(group => !appliedIds.has(group.id))
      const effective = applied?.effective ?? 'none'
      const defaults = applied?.defaults ?? []
      const injected = applied?.entries ?? []
      // The base layer is injected into every conversation and is deliberately
      // not part of the injected count above: it is the floor, not the quota.
      const base = applied?.base ?? []
      // The count comes from the Host half, so it stays right even when this
      // client is newer than the process it talks to and the list is absent.
      const injectedCount = applied?.injected ?? injected.length
      const listUnavailable = applied !== undefined && !Array.isArray(applied.entries) && injectedCount > 0
      const origin = effective === 'explicit'
        ? '本会话选择'
        : effective === 'default' ? t('applyDefault') : t('applyNone')

      /**
       * Store one injection limit.
       * @param {Record<string, number>} patch - Limits to change.
       * @returns {Promise<void>} Resolution after the reload.
       */
      const saveLimits = async (patch) => {
        setBusy(true)
        try {
          await call('settings.set', undefined, patch)
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      /**
       * Ask the model to sort the vault into reusable knowledge and one-off
       * notes, and optionally act on the verdicts.
       * @param {boolean} apply - Whether to write the verdicts.
       * @returns {Promise<void>} Resolution after the call.
       */
      const runCurate = async (apply) => {
        setCurating(true)
        try {
          const result = await call('curate', undefined, { apply, limit: 20 })
          setCure(result)
          if (apply) await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setCurating(false)
        }
      }

      /**
       * Persist one membership change against the current applied set.
       * @param {Set<string>} next - The applied group ids after the change.
       * @returns {Promise<void>} Resolution after the reload.
       */
      const saveSet = (next) => save(all.filter(group => next.has(group.id)).map(group => group.id))

      /**
       * Toggle one group, which is what a click on its tile means.
       * @param {Record<string, any>} group - Group tile that was pressed.
       * @returns {void}
       */
      const toggleGroup = (group) => {
        if (busy) return
        const next = new Set(appliedIds)
        if (next.has(group.id)) next.delete(group.id)
        else next.add(group.id)
        void saveSet(next)
      }

      /**
       * Move one dragged group tile between the two areas.
       * @param {DragEvent} event - Drop event.
       * @param {'applied'|'available'} zone - Area the tile was dropped on.
       * @returns {void}
       */
      const onDrop = (event, zone) => {
        event.preventDefault()
        setOver(null)
        let payload
        try {
          payload = JSON.parse(event.dataTransfer.getData('text/plain'))
        } catch (_error) {
          // A drag from outside this view carries no group payload; ignore it.
          return
        }
        if (payload?.kind !== 'group' || typeof payload.id !== 'string') return
        const next = new Set(appliedIds)
        if (zone === 'applied') next.add(payload.id)
        else next.delete(payload.id)
        if (next.size === appliedIds.size && next.has(payload.id) === appliedIds.has(payload.id)) return
        void saveSet(next)
      }

      /**
       * One group as a draggable tile.
       * @param {Record<string, any>} group - Group view.
       * @returns {unknown} React element.
       */
      const groupTile = (group) => h('div', {
        key: group.id,
        className: 'dsmv-gtile',
        draggable: true,
        // Dragging is one way to move the tile; a role, a tab stop and the
        // button keys are what make it usable without a pointer.
        role: 'button',
        tabIndex: 0,
        'aria-pressed': appliedIds.has(group.id),
        'aria-label': `${group.name}（${String(group.entryCount)} ${t('entries')}）`,
        title: t('knowledgeToggleHint'),
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          toggleGroup(group)
        },
        onDragStart: (event) => {
          event.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'group', id: group.id }))
          event.dataTransfer.effectAllowed = 'move'
        },
        onClick: () => { toggleGroup(group) },
      },
        h('div', { className: 'dsmv-gtile-name' }, group.name),
        h('div', { className: 'dsmv-row', style: { gap: '6px' } },
          h(Tag, null, group.scope === 'knowledge' ? t('knowledge') : t('conversation')),
          h('span', { className: 'dsmv-cap' }, `${String(group.entryCount)} ${t('entries')}`),
          Number(group.priority ?? 0) > 0
            ? h(Tag, { tone: 'info', title: t('priorityHint') }, `${t('priorityShort')}${String(group.priority)}`)
            : null,
        ),
        group.description === '' ? null : h('div', { className: 'dsmv-gtile-desc' }, group.description),
      )

      /**
       * One drop area.
       * @param {'applied'|'available'} id - Area identity.
       * @param {string} title - Area heading.
       * @param {string} hint - Drop hint.
       * @param {Record<string, any>[]} groups - Tiles in this area.
       * @param {string} empty - Empty-state text.
       * @returns {unknown} React element.
       */
      const zone = (id, title, hint, groups, empty) => h('div', {
        className: over === id ? 'dsmv-zone dsmv-zone--over' : 'dsmv-zone',
        onDragOver: (event) => { event.preventDefault(); setOver(id) },
        onDragLeave: () => { setOver(current => (current === id ? null : current)) },
        onDrop: (event) => { onDrop(event, id) },
      },
        h('div', { className: 'dsmv-zone-head' },
          h('span', { className: 'dsmv-cap' }, title),
          h('span', { className: 'dsmv-cap' }, hint),
        ),
        groups.length === 0
          ? h('div', { className: 'dsmv-empty' }, empty)
          : h('div', { className: 'dsmv-gboard' }, groups.map(groupTile)),
      )

      return h('div', { className: 'dsmv' },
        h(StyleSheet),
        h('div', { className: 'dsmv-scroll' },
          h('div', { className: 'dsmv-row' },
            h('div', { className: 'dsmv-col', style: { gap: '2px', flex: '1 1 320px' } },
              h('h2', { className: 'dsmv-title' }, t('knowledgeTitle')),
              h('div', { className: 'dsmv-sub' }, t('knowledgeSub')),
              h('div', { className: 'dsmv-cap' },
                `${t('apply')} · ${origin} · ${t('knowledgeInjected')} ${String(injectedCount)} ${t('applyEntries')}`),
            ),
            h('span', { className: 'dsmv-spacer' }),
            h(Button, { size: 'sm', disabled: busy, onClick: () => { void save(null) } }, t('applyReset')),
            h(Button, { size: 'sm', disabled: busy, onClick: () => { void save([]) } }, t('applyClear')),
            h(Button, {
              size: 'sm',
              icon: h(IconRefreshOutlineMedium, null),
              disabled: busy,
              onClick: () => { void load() },
            }, t('refresh')),
          ),

          error === null ? null : h('div', { className: 'dsmv-error' }, error),

          zone('applied', t('knowledgeApplied'), t('knowledgeDropRemove'), appliedGroups, t('knowledgeAppliedEmpty')),
          zone('available', t('knowledgeAvailable'), t('knowledgeDropApply'), availableGroups, t('knowledgeAvailableEmpty')),

          // Where summaries go is a separate axis from what this conversation
          // reads, so it gets its own row rather than sharing the tiles above.
          h('div', { className: 'dsmv-card' },
            h('div', { className: 'dsmv-row' },
              h('span', { className: 'dsmv-cap' }, t('bindLabel')),
              h(Pill, {
                active: (applied?.boundGroupId ?? null) === null,
                onClick: () => { void saveBinding(null) },
              }, t('bindDefault')),
              ...all.map(group => h(Pill, {
                key: group.id,
                active: applied?.boundGroupId === group.id,
                onClick: () => { void saveBinding(group.id) },
              }, group.name)),
            ),
            h('div', { className: 'dsmv-cap' }, t('bindHint')),
          ),

          h('div', { className: 'dsmv-cap' },
            `${t('applyDefaultNote')}：${defaults.length === 0 ? t('applyNone') : defaults.join('、')}`
            + (applied?.applyByDefault === true ? '' : `（${t('applyOff')}）`)),

          // The quota is a number the reader owns, so it is edited here rather
          // than only in a profile file that needs a host restart.
          h('div', { className: 'dsmv-card' },
            h('div', { className: 'dsmv-row' },
              h('span', { className: 'dsmv-cap' }, t('limitsLabel')),
              h(Button, {
                size: 'sm',
                disabled: busy || (applied?.maxEntries ?? 0) <= 0,
                onClick: () => { void saveLimits({ maxEntries: Math.max(0, Number(applied?.maxEntries ?? 0) - 1) }) },
              }, '−'),
              h('strong', null, String(applied?.maxEntries ?? 0)),
              h(Button, {
                size: 'sm',
                disabled: busy || Number(applied?.maxEntries ?? 0) >= 50,
                onClick: () => { void saveLimits({ maxEntries: Math.min(50, Number(applied?.maxEntries ?? 0) + 1) }) },
              }, '+'),
              h('span', { className: 'dsmv-cap' },
                `${t('limitsHint')}（${t('baseTitle')} P${String(applied?.baseMaxEntries ?? 0)} ${t('baseCount')}）`),
            ),
          ),

          // The base layer: always on, never counted against the quota above.
          h('div', { className: 'dsmv-card' },
            h('div', { className: 'dsmv-row' },
              h('span', { className: 'dsmv-cap' }, t('baseTitle')),
              h(Tag, { tone: 'success' }, t('baseCount')),
            ),
            base.length === 0
              ? h('div', { className: 'dsmv-empty' }, t('baseEmpty'))
              : base.map(entry => h('div', { key: entry.id, className: 'dsmv-kitem' },
                  h('div', { className: 'dsmv-row' },
                    h('strong', { style: { fontSize: 'var(--dsmv-fs-small)', fontWeight: 600 } },
                      entry.title === '' ? plainPreview(entry.content, 60) : entry.title),
                    h(Tag, null, entry.groupName ?? ''),
                  ),
                  h('div', { className: 'dsmv-kbody' },
                    h(MarkdownText, { text: entry.content, labels: props.markdownLabels ?? MARKDOWN_LABELS.zh })),
                )),
          ),

          h('div', { className: 'dsmv-card' },
            h('div', { className: 'dsmv-row' },
              h('span', { className: 'dsmv-cap' }, t('curateHint')),
              h('span', { className: 'dsmv-spacer' }),
              h(Button, {
                size: 'sm',
                disabled: curating || busy,
                onClick: () => { void runCurate(false) },
              }, curating ? t('curateBusy') : t('curateReview')),
              cure === null || cure.mode === 'applied'
                ? null
                : h(Button, { size: 'sm', disabled: curating, onClick: () => { void runCurate(true) } }, t('curateApply')),
            ),
            cure === null
              ? null
              : h('div', { className: 'dsmv-col' },
                  (cure.verdicts ?? []).length === 0
                    ? h('div', { className: 'dsmv-empty' }, t('curateEmpty'))
                    : null,
                  ...(cure.verdicts ?? []).map(item => h('div', { key: item.id, className: 'dsmv-row' },
                    h(Tag, { tone: item.verdict === 'reusable' ? 'success' : 'quiet' },
                      item.verdict === 'reusable' ? t('curateReusable') : t('curateOneoff')),
                    h('span', { className: 'dsmv-cap' }, item.reason),
                    item.group === '' || item.verdict !== 'reusable' ? null : h(Tag, null, item.group),
                  )),
                ),
          ),

          h('div', { className: 'dsmv-card' },
            h('div', { className: 'dsmv-row' },
              h('span', { className: 'dsmv-cap' },
                `${t('knowledgeInjected')} ${String(injectedCount)} ${t('applyEntries')}`),
              applied?.truncated === true ? h(Tag, { tone: 'warning' }, t('knowledgeTruncated')) : null,
            ),
            injected.length === 0
              ? h('div', { className: 'dsmv-empty' },
                  listUnavailable ? t('knowledgeListNeedsRestart') : t('knowledgeNone'))
              : injected.map(entry => h('div', { key: entry.id, className: 'dsmv-kitem' },
                  h('div', { className: 'dsmv-row' },
                    h('strong', { style: { fontSize: 'var(--dsmv-fs-small)', fontWeight: 600 } },
                      entry.title === '' ? plainPreview(entry.content, 60) : entry.title),
                    h(Tag, null, entry.groupName ?? ''),
                    h(Tag, { tone: entry.hidden === true ? 'warning' : 'outline' },
                      entry.scope === 'knowledge' ? t('knowledge') : t('conversation')),
                    // Why this memory is here: picked for this session, or
                    // carried in by a group. Priority explains the order.
                    h(Tag, { tone: entry.via === 'session' ? 'success' : 'quiet' },
                      entry.via === 'session' ? t('viaSession') : t('viaGroup')),
                    Number(entry.priority ?? 0) > 0
                      ? h(Tag, { tone: 'info', title: t('priorityHint') }, `${t('priorityShort')}${String(entry.priority)}`)
                      : null,
                  ),
                  h('div', { className: 'dsmv-kbody' },
                    h(MarkdownText, { text: entry.content, labels: props.markdownLabels ?? MARKDOWN_LABELS.zh })),
                )),
          ),
        ),
      )
    }

    /**
     * The memory choice offered while a conversation is still blank.
     *
     * The 知识 tab cannot cover this case: the shell does not render conversation
     * views for a blank session. The composer dock is rendered in both the
     * new-conversation screen and an established conversation, and the session
     * snapshot it receives carries `blank`, so the same choice can be offered
     * where a conversation starts and then hand over to the tab once it has
     * content.
     * @param {Record<string, any>} props - Dock props: session id, session snapshot, dictionary.
     * @returns {unknown} React element, or null once the conversation has started.
     */
    function NewConversationKnowledge(props) {
      const t = props.t
      const sessionId = props.sessionId
      const blank = props.session?.blank === true
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const load = React.useCallback(async () => {
        if (sessionId === undefined) return
        try {
          const [applied, vault] = await Promise.all([
            call('apply.get', { sessionId }),
            call('state'),
          ])
          setData({ applied, groups: vault.groups ?? [] })
          setError(null)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [sessionId])

      React.useEffect(() => { if (blank) void load() }, [load, blank])

      /**
       * Persist one application choice for the session about to start.
       * @param {string[]|null} next - Group ids, or null to fall back to the deployment default.
       * @returns {Promise<void>} Resolution after the reload.
       */
      const save = async (next) => {
        setBusy(true)
        try {
          await call('apply.set', undefined, { sessionId, groups: next })
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      // Only the blank state: an established conversation keeps the 知识 tab,
      // and showing both would be the same choice twice.
      if (sessionId === undefined || !blank) return null
      const applied = data?.applied
      const all = data?.groups ?? []
      const appliedIds = new Set((applied?.groups ?? []).map(group => group.id))
      const defaults = applied?.defaults ?? []

      /**
       * Toggle one group's membership.
       * @param {Record<string, any>} group - Group that was pressed.
       * @returns {void}
       */
      const toggle = (group) => {
        const next = new Set(appliedIds)
        if (next.has(group.id)) next.delete(group.id)
        else next.add(group.id)
        void save(all.filter(item => next.has(item.id)).map(item => item.id))
      }

      return h('div', { className: 'dsmv-dock' },
        h(StyleSheet),
        h('div', { className: 'dsmv-row' },
          h('span', { className: 'dsmv-cap' }, t('newChatLabel')),
          ...all.slice(0, 12).map(group => h(Pill, {
            key: group.id,
            active: appliedIds.has(group.id),
            title: `${group.name}（${String(group.entryCount)} ${t('entries')}）`,
            onClick: () => { if (!busy) toggle(group) },
          }, group.name)),
          all.length === 0 ? h('span', { className: 'dsmv-cap' }, t('boardEmpty')) : null,
          h(Button, {
            size: 'sm',
            disabled: busy || applied === undefined,
            onClick: () => { void save(null) },
          }, t('applyReset')),
        ),
        h('div', { className: 'dsmv-cap' },
          `${appliedIds.size === 0 ? `${t('newChatNone')} ` : ''}${t('newChatHint')}`),
        h('div', { className: 'dsmv-cap' },
          `${t('applyDefaultNote')}：${defaults.length === 0 ? t('applyNone') : defaults.join('、')} · ${t('newChatManage')}`),
        error === null ? null : h('div', { className: 'dsmv-error' }, error),
      )
    }

    /** Sidebar glyph for the panel entry. */
    function MemoryVaultIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true,
        style: { display: 'block' },
      },
        h('path', {
          d: 'M4 5.5h7.2c1 0 1.8.8 1.8 1.8V19H5.8C4.8 19 4 18.2 4 17.2V5.5Z',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M20 5.5h-5.2c-.6 0-1 .4-1 1V19h4.4c1 0 1.8-.8 1.8-1.8V5.5Z',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
        }),
        h('path', { d: 'M12 6.5V19', stroke: 'currentColor', strokeWidth: 1.6 }),
      )
    }

    return {
      inject: ['slots'],
      // The pure helpers are exercised by the standalone smoke test, which
      // cannot reach them through a browser render.
      helpers: { termsOf, tagsOf, autoTagOf, deriveTagInventory, plainPreview, highlighted },

      /**
       * Contribute the sidebar entry with the vault board it opens, and the
       * conversation's **知识** view beside 对话 and 轨迹.
       * @param {object} ctx - Browser plugin context.
       * @returns {void}
       */
      apply(ctx) {
        // The locale service is optional: with it the page follows the shell's
        // language, without it the built-in dictionary still renders.
        let t = (key) => STRINGS.zh[key] ?? key
        const locale = ctx.get('locale')
        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: STRINGS.zh, en: STRINGS.en }), 'memory-vault: dictionaries')
          const bound = locale.bind(NS)
          t = (key) => bound(key)
        }
        // The shell owns the document language; mirroring it keeps the
        // Markdown chrome (fence and footnote labels) in the reader's language.
        const english = typeof document !== 'undefined'
          && String(document.documentElement?.lang ?? '').toLowerCase().startsWith('en')
        const markdownLabels = english ? MARKDOWN_LABELS.en : MARKDOWN_LABELS.zh

        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            inject: () => ({ t, markdownLabels }),
          }, MemoryVaultPage)
        })

        // Order 20 places the tab after the shell's own views: chat is 0 and
        // the trajectory is 10.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: PANEL_ID,
          order: 20,
          label: () => t('apply'),
          inject: () => ({ t, markdownLabels }),
        }, KnowledgeView))

        // The blank new-conversation screen renders no conversation views, so
        // the same choice is offered there through the composer dock; the entry
        // hides itself as soon as the session stops being blank.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: PANEL_ID,
          order: 30,
          inject: () => ({ t }),
        }, NewConversationKnowledge))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: () => t('panel'),
        }, MemoryVaultIcon))
      },
    }
  },
})
