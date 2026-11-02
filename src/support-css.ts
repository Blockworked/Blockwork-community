// Styles for the helpdesk's pages (support.ts).

export const SUPPORT_CSS = `
.ticket-list { list-style: none; padding: 0; margin: 14px 0; }
.ticket-list li { border-bottom: 1px solid var(--glass-border); }
.ticket-list a.row { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; padding: 12px 6px; color: var(--fg); border-radius: var(--radius); }
.ticket-list a.row:hover { background: var(--hover); text-decoration: none; }
.ticket-list .subject { font-weight: 600; flex: 1; min-width: 12ch; overflow-wrap: anywhere; }
.ticket-list .num { color: var(--muted); font-variant-numeric: tabular-nums; }
.ticket-list .who-from, .ticket-list .time { color: var(--muted); font-size: 13px; }
.ticket-status { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--bg3); color: var(--muted); white-space: nowrap; }
.ticket-status.s-open { background: rgba(var(--accent-rgb), 0.16); color: var(--accent); }
.ticket-status.s-answered { background: rgba(48, 209, 88, 0.16); color: #30d158; }
:root[data-theme="light"] .ticket-status.s-answered { color: #1f8a3b; }
@media (prefers-color-scheme: light) { :root:not([data-theme]) .ticket-status.s-answered { color: #1f8a3b; } }
.tabs { display: flex; gap: 4px; flex-wrap: wrap; margin: 8px 0 4px; }
.tabs a { padding: 6px 12px; border-radius: var(--radius); font-size: 13px; color: var(--muted); }
.tabs a[aria-current] { background: var(--bg3); color: var(--fg); font-weight: 600; }
.tabs a:hover { background: var(--hover); text-decoration: none; }
.thread { list-style: none; padding: 0; margin: 20px 0; }
.thread .comment.staff .comment-main { border-left: 3px solid var(--accent); padding-left: 12px; }
.thread .comment.note .comment-main { border-left: 3px solid var(--warn-border); padding-left: 12px; }
.support-form label.field { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
.support-form input[type=text], .support-form input[type=email] { width: 100%; max-width: none; }
input[type=email] { font: inherit; font-size: 13px; padding: 7px 10px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg2); color: var(--fg); }
input[type=email]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.28); }
.support-form textarea { min-height: 160px; }
.ticket-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
.ways { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
`;
