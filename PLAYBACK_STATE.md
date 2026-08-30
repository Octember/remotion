# Playback state readers

`playingStore` is the single source of truth for playback. Use `usePlaying()`
for rendering and effects that should react to playback changes. Keep an
imperative getter only when an action must sample playback at the instant it
runs.

## Source and wiring

- `packages/core/src/TimelineContext.tsx` owns the core store, snapshot getter,
  and subscription.
- `packages/core/src/use-playing.ts` is the only reactive bridge.
- `packages/player/src/Player.tsx` provides the equivalent Player-local store.

## Reactive readers

- `packages/core/src/use-media-playback.ts`
- `packages/media/src/audio/audio-for-preview.tsx`
- `packages/media/src/video/video-for-preview.tsx`
- `packages/media/src/media-player.ts` and
  `packages/media/src/video-iterator-manager.ts` receive that reactive value.
- `packages/player/src/use-playback.ts`
- `packages/player/src/browser-mediasession.ts`
- `packages/player/src/PlayerUI.tsx` poster rendering
- `packages/studio/src/components/FpsCounter.tsx`
- `packages/studio/src/components/FramePersistor.tsx`
- `packages/studio/src/components/ZoomPersistor.tsx`
- `packages/studio/src/components/Timeline/TimelinePlayCursorSyncer.tsx`
- `packages/studio/src/components/PlayPause.tsx`

These all use `usePlaying()` and must not create a second `useState` mirror or
subscribe to Player `play` and `pause` events.

`use-media-playback.ts` keeps its synchronization decision reactive and shares
the native pause action within that Effect.

## Imperative readers

- `packages/player/src/use-player-methods.ts` and `PlayerRef.isPlaying()`
- `packages/player/src/use-playback.ts` RAF loop
- `packages/player/src/PlayerUI.tsx` commands and imperative ref
- `packages/player/src/PlayerSeekBar.tsx`
- `packages/studio/src/components/WebMcp.tsx`
- `packages/studio/src/components/PlaybackKeyboardShortcutsManager.tsx`
- `packages/studio/src/components/Timeline/TimelineDragHandler.tsx`
- `packages/core/src/use-media-tag.ts`

These read the TimelineContext getter because a hook value could be stale by
the time the command callback runs.

## Static readers

`packages/core/src/freeze.tsx`, `packages/player/src/Thumbnail.tsx`, and test
helpers always report `false`. `usePlaying()` still works there: Freeze
supplies the false snapshot, and Thumbnail uses the no-op subscription
fallback.

## Public Player consumers

Player examples, promo controls, and `@remotion/player-a11y` listen to public
Player events because `usePlaying()` is intentionally internal. Their local
state is part of the public Player API boundary, not a second core playback
source of truth.
