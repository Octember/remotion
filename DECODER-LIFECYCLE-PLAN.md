# Media Retention and Decoder Lifecycle

## Simple Plan

### What the first attempt proved

The expensive media input, track, and `CanvasSink` now correctly belong to the
Player/timeline resource manager instead of each short-lived `MediaPlayer`.
The trace improved and those objects survive presentation churn. The remaining
black frames are not evidence that this lifetime change failed.

The failed assumption was that revisiting a decoded asset usually means asking
for the same exact source timestamp. Scrubbing disproved that. A remounted
presentation generally asks the same asset for a different nearby or distant
timestamp, so the one retained frame fails an exact-timestamp lookup and the new
canvas remains empty while Mediabunny decodes. We retained useful pixels but
refused to present them.

The first attempt also put a single request generation on the shared asset.
That is the wrong concurrency boundary. Visible, premounted, and postmounted
presentations may legitimately request the same asset at once. A request from
one presentation must not make another presentation's successful decode
ineligible for retention. Stale painting is already a presentation concern and
belongs to that `MediaPlayer`'s nonce/disposal checks.

### Revised plan

1. Keep the ownership already introduced. The existing Player/timeline
   resource manager owns one `VideoAsset` and one Mediabunny `CanvasSink` per
   source track. Do not add another registry, decoder pool, timestamp cache, or
   idle decoder lifetime.
2. Keep one stable raw frame per recently used asset, bounded by the existing
   aggregate three-frame/64 MB budget. The frame is a continuity placeholder,
   not a claim that the requested exact frame is ready.
3. Preserve continuity in this strict priority order: keep the current
   presentation's pixels if it already drew a frame; otherwise paint the
   asset's retained frame even when its timestamp differs from the target;
   otherwise remain blank on the asset's first visit. Never replace valid
   current-presentation pixels with an older asset placeholder. Apply the new
   presentation's current effects and dimensions when a placeholder is needed.
4. Start the normal exact `CanvasSink.getCanvas(timestamp)` request when paused,
   or the normal sequential `CanvasSink.canvases(start, end)` operation when
   playing, before awaiting placeholder paint. This starts decoding promptly
   while preserving the ordering that the exact frame is committed after the
   placeholder. Keep the existing delay/buffering handle blocked until the
   actual requested frame is ready; placeholder paint must not signal decode
   completion.
5. Replace the placeholder only after the presentation's existing nonce and
   disposal checks prove the result still belongs to that presentation. A late
   result may neither paint over a newer seek nor invoke presentation callbacks.
6. After a result passes those checks, paint it and publish a stable copy to the
   shared asset. Remove the asset-wide request generation: concurrent valid
   presentations may all complete, and whichever valid decode publishes last
   becomes the next continuity placeholder.
7. Give placeholder paint explicit semantics in `MediaPresentation`. It may
   update the pixels used by effect redraws, but it must not increment the
   decoded-frame count, invoke `onVideoFrame`, or release buffering. Only the
   requested decoded frame uses the normal `drawFrame()` completion path.
8. Preserve the exact-match distinction only for diagnostics. Emit
   self-contained scalar logs rather than collapsed `Object` payloads. Log a
   retained paint as `exact` or `placeholder`, along with retained and target
   timestamps, delta, asset identity, presentation identity, request kind,
   decode completion/cancellation, eviction, retained bytes, and disposal.
   Never call a mismatched placeholder a cache hit or an exact frame.
9. Dispose retained pixels through the existing resource registry: eviction
   clears the owning asset's reference, input invalidation disposes that asset,
   and Player/timeline teardown disposes the shared budget. `MediaPlayer`
   disposal still clears only its destination canvas and active operations.

### Non-negotiable invariants

- A placeholder can only come from the same resource key and video track as the
  requested frame. Credentials, request options, source revision, and track ID
  remain part of that identity; pixels can never cross assets.
- A placeholder is allowed to be temporally distant. That trade is explicit:
  valid pixels from the correct asset are preferable to black. Exactness is
  restored only by the requested decode.
- Existing presentation pixels always outrank shared retained pixels. The
  shared placeholder is only a bootstrap for a presentation that has not drawn
  anything yet.
- The decode operation starts without waiting for effects on the placeholder,
  but the exact frame is always the final commit for that request.
- Only a live presentation's current request may commit pixels. Disposal or a
  newer seek makes earlier work ineligible before any draw, publish, callback,
  or buffering transition.
- Placeholder paint is presentation-only. It cannot mutate media time, satisfy
  a seek, increment decoded-frame accounting, invoke `onVideoFrame`, or unblock
  playback.
- Retention remains bounded to one frame per retained asset and three frames/64
  MB per Player resource manager. Eviction and teardown are deterministic.
- Neither retaining nor painting a frame owns a Mediabunny iterator or decoder.
  Retrieval-operation cleanup remains unchanged.

Paused exact seeks remain `CanvasSink.getCanvas(timestamp)`. Continuous
playback remains `CanvasSink.canvases(start, end)`, with its iterator closed on
pause, jump, or unmount. Mediabunny still owns decoder creation and cleanup.

This deliberately chooses a temporarily stale frame from the correct source
track over an empty black canvas. First visits can still be blank because the
asset has no decoded pixels yet. After the first successful decode for an asset,
presentation churn must not show black while a replacement frame is pending.
The exact destination frame still arrives asynchronously and retains its normal
buffering and callback semantics.

Do not add a multi-timestamp cache unless measurements later establish a
separate need for faster exact-frame arrival. It is not needed to solve visual
continuity, and it would reintroduce the cache design we are trying to avoid.

- [Mediabunny guide: Media sinks](https://mediabunny.dev/guide/media-sinks)

## Goal

Keep exact-frame preview seeks warm without treating browser media resources as
unbounded. React and DOM lifetime are presentation concerns; container, byte
cache, decoded-frame, and codec lifetime must be managed independently.

This document covers the Mediabunny/WebCodecs preview path. In this document,
"Remotion today" means upstream `main`; "the current branch" means the stacked
prototype that introduced `VideoAsset`; and "the target" means the plan above.

## How Remotion Does It Today

### Ownership from React to Mediabunny

The current upstream path is:

```text
VideoForPreview React effect
  -> one MediaPlayer for that mounted <MediaVideo>
  -> one shared Input lease keyed by src + request identity
  -> one videoIteratorManager owned by that MediaPlayer
  -> one CanvasSink owned by that videoIteratorManager
  -> one active canvases() iterator, plus an optional prewarmed loop iterator
  -> Mediabunny VideoSampleSink
  -> operation-local VideoDecoder
  -> copied stable canvas
  -> presentation canvas
```

`VideoForPreview` constructs `MediaPlayer` in an effect and calls
`MediaPlayer.dispose()` in the effect cleanup. A Remotion mount boundary is
therefore a `MediaPlayer` lifetime boundary even when another range uses the
same source immediately afterward.

`MediaPlayer` acquires an `Input` through `acquireSharedInput()`. On upstream
`main`, that function uses `globalMediaResourceManager`, keyed by source URL,
credentials, request options, and revision. The manager reference-counts the
`Input`, caches derived values such as duration beside it, and calls
`Input.dispose()` when its last lease is released. A microtask grace period
allows a same-turn reacquisition to cancel disposal.

This already separates container lifetime from DOM lifetime imperfectly: two
simultaneously mounted players can share one `Input`, but a gap longer than one
microtask destroys it. In a Player or timeline, `useResourceManager()` instead
creates a manager with `disposeWhenUnused: false` and disposes all retained
resources only with the owning provider. The current branch passes that manager
into `@remotion/media`; upstream still reaches for the global manager directly.

### The current upstream video state machine

After resolving and validating the primary video track, upstream constructs
`videoIteratorManager()`. This object owns both kinds of state:

- presentation state: destination canvas/context, effects, callbacks, delay
  handles, debug drawing, and the last presented frame;
- media state: `CanvasSink`, current iterator, current seek timestamp, loop
  prewarm iterators, copied-frame pool, and decoder-producing iterator cleanup.

It creates one `CanvasSink(videoTrack, {poolSize: 3, fit: 'contain', alpha:
true})`. Sink construction itself does not create a decoder. The decoder is
created only when a sink retrieval operation begins.

For the first frame, `startVideoIterator()` calls
`createVideoIterator(timeToSeek)`. That reaches
`canvasesAheadOfTime()`, which calls `CanvasSink.canvases(startTimestamp)` and
immediately pulls the first item. It then keeps a three-slot look-ahead buffer
full. Each pooled Mediabunny canvas is copied into a stable `OffscreenCanvas`
because `CanvasSink.poolSize: 3` reuses its output canvases.

For every subsequent Remotion seek, `tryToSatisfySeek()` inspects the retained
current and peeked frames:

- a small forward advance while playing consumes the existing sequential
  iterator;
- a timestamp already covered by the current frame reuses that copied frame;
- a backward seek, non-sequential jump, or unavailable pending frame returns
  `not-satisfied`;
- `videoIteratorManager.seek()` responds by destroying the old iterator and
  starting another `CanvasSink.canvases(newTime)` iterator.

For looping, Remotion creates a second `canvases(loopStart)` iterator within one
second of the loop end. That iterator begins filling before the active iterator
finishes and is swapped in at the loop boundary. Thus one mounted video can
temporarily own two active Mediabunny decoding operations.

Destroying a Remotion video iterator calls the underlying async iterator's
`.return()`. Destroying `videoIteratorManager` closes the active iterator and
all loop-prewarmed iterators, clears its retained presentation frame, and
clears the destination canvas. `MediaPlayer.dispose()` invokes this destruction
before releasing the shared `Input` lease.

### What Mediabunny actually does underneath

`CanvasSink` contains track/configuration state, a lazily initialized geometry
promise, one `VideoSampleSink`, and an optional reusable canvas pool. Its
constructor does not create a `VideoDecoder`.

Its three retrieval forms have distinct intended workloads:

- `getCanvas(timestamp)` delegates to `VideoSampleSink.getSample(timestamp)`,
  which runs a one-timestamp `mediaSamplesAtTimestamps([timestamp])` operation;
- `canvases(start, end)` delegates to the sequential `samples()` operation and
  pre-decodes ahead;
- `canvasesAtTimestamps(timestamps)` delegates to the sparse-access operation
  and, for monotonic timestamps, avoids decoding the same packets repeatedly.

Each retrieval operation creates its own decoder wrapper. For sparse timestamp
retrieval, Mediabunny groups targets by keyframe, decodes from the relevant key
packet through the furthest requested packet, flushes when the keyframe changes
or time moves backward, bounds its decode/sample queues, closes discarded
samples, and closes the decoder in the operation's `finally` block.

Calling `.return()` marks the iterator terminated and closes queued samples.
That causes the operation pump to finish and its `finally` block to close the
decoder. A normal `for await` completion and a `break` have the same cleanup
semantics. The lifetime boundary is therefore the retrieval operation, not the
`CanvasSink` object.

The canvas pool bounds reusable output canvases and VRAM churn; it does not
cache decoded media or keep a decoder warm. Retained pooled results are mutable
because later output wraps around and redraws the same canvas. Remotion's
stable-copy pool is consequently necessary only for frames that outlive the
immediate sink result.

Relevant implementation:

- `packages/media/src/video/video-for-preview.tsx`
- `packages/media/src/media-player.ts`
- `packages/media/src/video-iterator-manager.ts` on upstream `main`
- `packages/media/src/video/video-preview-iterator.ts`
- `packages/media/src/canvas-ahead-of-time.ts`
- `packages/media/src/prewarm-iterator-for-looping.ts`
- `packages/media/src/get-shared-input.ts`
- `packages/core/src/media-resource-manager.ts`
- [Mediabunny guide: Media sinks](https://mediabunny.dev/guide/media-sinks)

## Specific Diff: Mediabunny's Model vs Remotion's

| Concern                | Mediabunny's model                            | Remotion today                                                  | Target Remotion model                                                        |
| ---------------------- | --------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Durable track accessor | One cheap, reusable sink per track            | Sink is buried inside a per-mounted-player iterator manager     | Retain `Input` + track + `CanvasSink` in the Player resource manager         |
| Exact paused seek      | `getCanvas(timestamp)`                        | Reuse or restart a sequential `canvases(timestamp)` iterator    | Call `getCanvas(timestamp)`; latest request wins per presentation            |
| Continuous playback    | `canvases(start, end)`                        | Correct primitive, wrapped by custom look-ahead and seek logic  | Keep a playback-owned sequential iterator                                    |
| Sparse known targets   | `canvasesAtTimestamps(timestamps)`            | Not used by preview playback                                    | Use for finite monotonic scrub/prefetch batches only                         |
| Decoder lifetime       | One retrieval operation                       | One retained sequential iterator, plus optional loop iterator   | One active playback/read operation; never an idle retained decoder           |
| Random jump            | Independent sink call                         | Destroy active iterator, construct another sequential iterator  | End playback iterator if necessary, then perform exact retrieval             |
| Loop warm-up           | Caller may start a second finite operation    | Remotion prewarms and retains a second open sequential iterator | Preserve only if measurement proves it helps; scope it to the loop operation |
| Presentation lifetime  | Outside the sink                              | Coupled to sink and iterator in `videoIteratorManager`          | `MediaPresentation` remains mount-scoped and independently disposable        |
| Stable displayed frame | Caller responsibility                         | Copies pooled output and retains current/peeked frames          | Keep one bounded asset frame for empty-presentation continuity               |
| Cleanup                | Iterator completion/`return()` closes decoder | Custom `destroy()` eventually delegates to iterator `return()`  | Operation owner always closes iterator; Player manager disposes `Input`      |
| Resource reuse         | Reuse sink; calls are independent             | Reuse an active iterator state machine                          | Reuse sink and container state, not decoder state                            |

### Current branch versus the target

The current branch has the intended ownership shape:

1. DOM, effects, callbacks, and current-presentation state are mount-scoped in
   `MediaPresentation`.
2. The Player/timeline resource manager owns the shared `Input`, track-scoped
   `VideoAsset`, `CanvasSink`, and bounded retained-frame budget.
3. Decoder-producing retrieval operations remain request/playback-scoped and
   are not retained merely because the asset survives.

The remaining correction is presentation policy, not another lifecycle
refactor:

```diff
- retained frame lookup requires exact timestamp
- miss leaves a new presentation canvas empty
- shared asset generation treats concurrent presentations as stale
+ retained frame always paints as a continuity placeholder
+ exact/sequential decode proceeds without changing buffering semantics
+ presentation nonce prevents stale paint
+ every still-valid completed decode may become the asset's next placeholder
```

No decoder cache or new registry is introduced.

The implementation delta should stay local:

- `VideoAsset`: expose the one retained frame and its timestamp; remove shared
  request generations; retain only caller-validated decoded results.
- `MediaPresentation`: distinguish `paintPlaceholder()` from `drawFrame()` and
  expose whether this presentation already has pixels.
- `MediaPlayer`: start the requested retrieval, preserve current pixels or
  bootstrap from the asset, then nonce-check, draw, and publish the result.
- `retained-video-frame-budget` and the core resource registry: no policy or
  ownership changes.

## Browser Constraint

WebCodecs does not publish a portable decoder-count limit. The limit is chosen
by the browser and platform and varies with codec, resolution, hardware
acceleration, GPU/CPU memory, other tabs, and concurrent media work.

The WebCodecs specification calls CPU memory, GPU memory, and exclusive codec
hardware handles "codec system resources." It says they may be quickly
exhausted and should be released immediately when unused. Codec saturation is
explicitly implementation-specific. Therefore neither DOM node count nor a
successful decoder allocation establishes a reusable numeric browser limit.

Relevant documentation:

- [WebCodecs: codec resources, saturation, and resource reclamation](https://w3c.github.io/webcodecs/)
- [MDN: `VideoDecoder.close()` releases system resources](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/close)
- [Chrome: close frames before garbage collection](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs)
- [MDN: bound decode queues and explicitly close codecs and frames](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Using_the_WebCodecs_API)

## Retention Boundary

| Resource                                          | Lifetime                                                 | Cleanup owner                                                               |
| ------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `Input`, `UrlSource`, parsed metadata, byte cache | Player resource                                          | Existing media resource manager calls `Input.dispose()`                     |
| `InputVideoTrack` and `CanvasSink`                | Same as their `Input`                                    | Released with the `Input`; no decoder is held merely by retaining the sink  |
| `MediaPresentation` and destination canvas        | Mounted `MediaPlayer`                                    | `MediaPlayer.dispose()`                                                     |
| Sequential `canvases()` iterator                  | One playback operation                                   | Stop, jump, unmount, or normal iterator completion calls/causes `.return()` |
| `getCanvas()` decoder operation                   | One exact-frame request                                  | Mediabunny closes it when the finite request completes                      |
| `canvasesAtTimestamps()` iterator                 | One finite sparse batch                                  | Consumer completion, `break`, or `.return()`                                |
| Copied stable canvas                              | Recently used asset, within the shared frame/byte budget | Asset disposal or budget eviction drops the stable copy                     |

The intended ordering is:

```text
exact request <= playback operation <= presentation mount < Input/sink resource <= Player
```

There is no idle-decoder tier. A retained sink is not a retained decoder.
Inputs still need a future aggregate byte/cache policy if the Player can touch
an unbounded number of distinct sources, but that is independent of decoder
lifecycle and is not part of this change.

## Diagnostics and Acceptance

Record these values per lifecycle event while validating the prototype:

- source key and track ID
- sink identity and presentation identity
- retrieval kind: exact, sequential, or sparse batch
- retrieval start, completion, cancellation, and iterator-return reason
- observed active decoder operations
- Input count and configured cache bytes
- copied-frame count and estimated pixel bytes
- seek request time, first presented-frame time, and stale-request suppression
- whether continuity paint was absent, exact, or a mismatched placeholder
- placeholder timestamp, requested timestamp, and replacement latency
- whether a placeholder incorrectly fired completion callbacks or unblocked playback

The design is successful when repeated forward/backward boundary scrubbing:

- does not accumulate decoders as media components mount and unmount;
- never leaves an iterator open after its playback/read operation ends;
- keeps the shared `Input` and sink identity stable across range mounts;
- uses exact retrieval instead of a sequential iterator for paused random seeks;
- after an asset's first decode, immediately paints retained pixels into every
  new presentation and keeps them visible until the requested frame is ready;
- never labels a mismatched placeholder as exact, never fires `onVideoFrame`
  for it, and never lets it release the buffering handle;
- rejects late decode results at the presentation boundary while allowing
  concurrent valid presentations to update shared retained pixels;
- releases all media resources at Player teardown; and
- preserves playback, looping, audio synchronization, effects, cancellation,
  and exact-frame semantics.

Before implementation is considered complete, exercise these cases directly:

1. First visit to an asset: blank is allowed until its first decoded frame.
2. Remount at the same timestamp: exact retained paint, then normal replacement.
3. Remount at a different timestamp: stale placeholder appears immediately,
   exact frame replaces it, and callbacks fire only for the exact frame.
4. Seek within an already-painted presentation: its current pixels remain until
   replacement; the shared placeholder does not overwrite them.
5. Rapid A -> B -> C seek: neither A nor B may paint after C becomes current.
6. Visible plus pre/postmounted consumers of one asset: all may decode without
   invalidating one another; none may paint into another presentation.
7. Effects change while a placeholder is visible: repaint uses current effects
   without changing decode-completion accounting.
8. Budget eviction and source invalidation: evicted pixels cannot be painted;
   retained bytes return to zero on Player/timeline teardown.
9. Playback, pause, loop, reverse/jump, fallback, and disposal: iterators close
   exactly as before and no decoder operation survives its owner.
