# 2. Stat polling everywhere instead of fs.watch

Status: accepted (2026-11)

## Context

The extension must notice, within a few seconds, when a transcript, a `conversations/<id>.db`, the window's `state.vscdb` (selection) or the `annotations/` folder changes. The extension host may run on the WSL side while some files sit on the Windows side under `/mnt/c`, where inotify (and so `fs.watch` / `FileSystemWatcher`) misses changes. A mix of native watching in some places and polling in others means two code paths with different failure modes.

## Decision

One stat poller (mtime + size) for every watched path; no `fs.watch`.

- Tracked Conversations' transcript and `conversations/<id>.db`: every 1.5 s.
- This window's `state.vscdb` (selection): every 1 s.
- `annotations/` listing and `conversation_summaries.db`: every 5 s.
- Unfocused window: 5× slower, catching up at once on focus.
- A change triggers the read (and the RPC call, after 500 ms of quiet); nothing is read on a timer if nothing changed.

## Consequences

- Behaves the same on ext4, `/mnt/c` and `\\wsl$`; one code path to test with an injected clock and filesystem.
- Up to ~1.5 s lag (7.5 s unfocused), within the "a few seconds is fine" requirement.
- A small constant cost of `stat` calls; bounded because only tracked Conversations are polled at the fast rate.

See [Where does the extension run under WSL, and what can it reach?](../../wayfinder/context-viewer/04-extension-host-wsl.md), [How do the data sources, watching, parsing and UI fit together?](../../wayfinder/context-viewer/15-architecture.md), [research](../research/extension-host-wsl.md), [spec](../spec/context-viewer.md).
