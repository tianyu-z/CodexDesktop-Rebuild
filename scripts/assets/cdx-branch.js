/**
 * cdx-branch.js — message version branching for chatgpt-dev.
 *
 * Injected by scripts/patch-branch-edit.js into webview/assets/ and imported by
 * the three renderer chunks that need it. Owns:
 *
 *   - a per-session turnId -> turn index table, recorded while the transcript
 *     renders (turn index is stable across forks because forks copy the whole
 *     prefix verbatim, turn ids are not)
 *   - a localStorage registry of message versions:
 *       of[threadId]        = familyId
 *       fam[familyId][idx]  = [oldestVersionThreadId, ..., liveThreadId]
 *   - the `< n/m >` switcher rendered under a user message
 *
 * Editing is destructive upstream (thread/revert truncates the tail), so the
 * "branch" mode forks a full snapshot of the thread *before* the edit lands.
 * The snapshot keeps the pre-edit history; the original thread id keeps moving
 * forward and is always the last entry in the version list.
 */
const LS_KEY = "cdx.branchVersions.v1";

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const s = raw == null ? null : JSON.parse(raw);
    if (s && typeof s === "object" && s.of && s.fam) return s;
  } catch {}
  return { of: {}, fam: {} };
}

function save(s) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {}
}

const api = {
  /** "branch" (fork a snapshot, default) or "inplace" (destructive truncate). */
  mode: null,
  /** Set by the thread view each render: (threadId) => void. */
  nav: null,
  /** threadId -> { turnId: turnIndex }, rebuilt every session. */
  _idx: Object.create(null),

  noteTurn(threadId, turnId, index) {
    if (threadId == null || turnId == null || typeof index !== "number") return;
    const m = this._idx[threadId] || (this._idx[threadId] = Object.create(null));
    m[turnId] = index;
  },

  turnIndex(threadId, turnId) {
    const m = this._idx[threadId];
    const i = m == null ? undefined : m[turnId];
    return typeof i === "number" ? i : null;
  },

  versions(threadId, turnId) {
    const idx = this.turnIndex(threadId, turnId);
    if (idx == null) return null;
    const s = load();
    const fam = s.of[threadId];
    if (fam == null) return null;
    const list = s.fam[fam] && s.fam[fam][idx];
    if (!Array.isArray(list) || list.length < 2) return null;
    const pos = list.indexOf(threadId);
    return pos < 0 ? null : { list, pos };
  },

  /** Record `snapId` as the version of (threadId, idx) that precedes `threadId`. */
  record(threadId, snapId, idx) {
    if (threadId == null || snapId == null || idx == null) return;
    const s = load();
    const fam = s.of[threadId] || threadId;
    s.of[threadId] = fam;
    s.of[snapId] = fam;
    const byIdx = s.fam[fam] || (s.fam[fam] = {});
    const list = byIdx[idx] || (byIdx[idx] = []);
    if (!list.includes(threadId)) list.push(threadId);
    if (!list.includes(snapId)) list.splice(list.indexOf(threadId), 0, snapId);
    save(s);
  },

  /**
   * Called from the thread view right before a destructive edit is dispatched.
   * `fork()` must create a full copy of the current thread and resolve to its id.
   */
  async beforeEdit({ threadId, turnId, fork }) {
    const mode = this.mode;
    this.mode = null;
    if (mode === "inplace") return;
    const idx = this.turnIndex(threadId, turnId);
    const snapId = await fork();
    if (snapId == null) throw new Error("Could not save the previous message version. Editing was cancelled.");
    if (snapId != null && idx != null) this.record(threadId, snapId, idx);
  },

  /** Renders the `< n/m >` version switcher, or null when there is nothing to switch. */
  switcher(jsx, threadId, turnId) {
    try {
      const v = this.versions(threadId, turnId);
      if (v == null) return null;
      const go = (i) => {
        const id = v.list[i];
        if (id != null && id !== threadId && this.nav != null) this.nav(id);
      };
      const arrow = (label, disabled, onClick, aria, key) =>
        jsx.jsx(
          "button",
          {
            type: "button",
            disabled,
            "aria-label": aria,
            className:
              "px-0.5 leading-none disabled:opacity-25 hover:text-codex-primary",
            onClick,
            children: label,
          },
          key,
        );
      return jsx.jsxs(
        "div",
        {
          className:
            "me-1 flex select-none items-center gap-0.5 text-xs text-codex-description",
          children: [
            arrow("‹", v.pos === 0, () => go(v.pos - 1), "Previous version", "p"),
            jsx.jsx("span", { children: `${v.pos + 1}/${v.list.length}` }, "c"),
            arrow(
              "›",
              v.pos === v.list.length - 1,
              () => go(v.pos + 1),
              "Next version",
              "n",
            ),
          ],
        },
        "cdx-branch-switcher",
      );
    } catch {
      return null;
    }
  },
};

globalThis.__cdxBranch = globalThis.__cdxBranch || api;

export default globalThis.__cdxBranch;
