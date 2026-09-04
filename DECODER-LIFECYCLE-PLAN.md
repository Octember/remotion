# Media Retention and Decoder Lifecycle

## Plan

Use Mediabunny's media-sink lifecycle instead of inventing a Remotion-owned
decoder cache.

1. Retain one `CanvasSink` per video track in the existing Player resource
   manager. The durable media resource is the `Input`, track, and sink, not a
   decoder or an active iterator.
2. Use `getCanvas(timestamp)` for an isolated exact-frame seek.
3. Use `canvases(startTime)` for continuous playback. The playback operation
   owns this iterator and ends it with `break` or `.return()` when playback or
   its presentation ends.
4. Use `canvasesAtTimestamps(timestamps)` for a finite scrub or prefetch batch
   when the target timestamps are known together.
5. Let Mediabunny create and release the operation-scoped decoder. Do not keep
   idle iterators or decoders alive, and do not add a decoder registry, TTL, or
   LRU.
6. Configure the sink's canvas pool to bound reusable output canvases. Copy any
   pixels that must remain visible after a sink result is returned or its pool
   entry is reused.
7. Dispose the retained `Input` and sink resources only when their Player-level
   resource entry is evicted or the Player is destroyed. Mounting and
   unmounting a `MediaPlayer` only attaches and detaches presentation state.

This follows Mediabunny's intended boundary: sinks are cheap, reusable,
track-scoped accessors whose calls are independent, while async iterators own
the decoder resources used by a particular read. Iterator completion performs
decoder cleanup. The existing `VideoAsset` abstraction should therefore stop
turning `CanvasSink.canvases()` into a persistent, manually managed decoder
lifecycle.

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

| Concern | Mediabunny's model | Remotion today | Target Remotion model |
| --- | --- | --- | --- |
| Durable track accessor | One cheap, reusable sink per track | Sink is buried inside a per-mounted-player iterator manager | Retain `Input` + track + `CanvasSink` in the Player resource manager |
| Exact paused seek | `getCanvas(timestamp)` | Reuse or restart a sequential `canvases(timestamp)` iterator | Call `getCanvas(timestamp)`; latest request wins |
| Continuous playback | `canvases(start, end)` | Correct primitive, wrapped by custom look-ahead and seek logic | Keep a playback-owned sequential iterator |
| Sparse known targets | `canvasesAtTimestamps(timestamps)` | Not used by preview playback | Use for finite monotonic scrub/prefetch batches only |
| Decoder lifetime | One retrieval operation | One retained sequential iterator, plus optional loop iterator | One active playback/read operation; never an idle retained decoder |
| Random jump | Independent sink call | Destroy active iterator, construct another sequential iterator | End playback iterator if necessary, then perform exact retrieval |
| Loop warm-up | Caller may start a second finite operation | Remotion prewarms and retains a second open sequential iterator | Preserve only if measurement proves it helps; scope it to the loop operation |
| Presentation lifetime | Outside the sink | Coupled to sink and iterator in `videoIteratorManager` | `MediaPresentation` remains mount-scoped and independently disposable |
| Stable displayed frame | Caller responsibility | Copies pooled output and retains current/peeked frames | Copy only frames that must survive pool reuse or operation completion |
| Cleanup | Iterator completion/`return()` closes decoder | Custom `destroy()` eventually delegates to iterator `return()` | Operation owner always closes iterator; Player manager disposes `Input` |
| Resource reuse | Reuse sink; calls are independent | Reuse an active iterator state machine | Reuse sink and container state, not decoder state |

### Current branch versus the target

The current branch correctly made two architectural moves:

1. It split DOM/effects/callback work into mount-scoped `MediaPresentation`.
2. It made the Player/timeline resource manager, rather than a module global,
   own the shared `Input` lifetime.

Its `VideoAsset` experiment then went one step too far. It moved the existing
`CanvasSink` plus active `VideoIterator`, loop-prewarm cache, current/peeked
stable frames, and seek cursor into reusable slots stored beside the `Input`.
Releasing a `MediaPlayer` only marks a slot idle; it does not destroy the
iterator. This preserves a live decoder operation across DOM unmount, and
multiple overlapping mounts allocate additional slots. Those idle slots have
no eviction or destruction path until the entire resource manager disposes the
`Input`.

The specific correction is:

```diff
- Player resource -> Input -> leased VideoAsset slots
- VideoAsset -> CanvasSink + active VideoIterator + loop iterator cache
- unmount -> mark VideoAsset idle, retain its decoder operation
+ Player resource -> Input -> track-scoped CanvasSink
+ mount -> MediaPresentation only
+ paused exact seek -> CanvasSink.getCanvas(timestamp)
+ playback -> operation-scoped CanvasSink.canvases(start, end)
+ unmount/stop/jump -> iterator.return()
+ Player teardown -> Input.dispose()
```

Keep `MediaPresentation`. Keep Player-scoped `Input` ownership. Replace
`VideoAsset` slot leasing with one sink value per track. Move the current frame,
seek cursor, playback iterator, loop operation, and cancellation nonce to the
consumer operation that actually needs them. No decoder cache is introduced.

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

| Resource | Lifetime | Cleanup owner |
| --- | --- | --- |
| `Input`, `UrlSource`, parsed metadata, byte cache | Player resource | Existing media resource manager calls `Input.dispose()` |
| `InputVideoTrack` and `CanvasSink` | Same as their `Input` | Released with the `Input`; no decoder is held merely by retaining the sink |
| `MediaPresentation` and destination canvas | Mounted `MediaPlayer` | `MediaPlayer.dispose()` |
| Sequential `canvases()` iterator | One playback operation | Stop, jump, unmount, or normal iterator completion calls/causes `.return()` |
| `getCanvas()` decoder operation | One exact-frame request | Mediabunny closes it when the finite request completes |
| `canvasesAtTimestamps()` iterator | One finite sparse batch | Consumer completion, `break`, or `.return()` |
| Copied stable canvas | Only while it is needed for presentation continuity | Owning presentation/operation returns it to the copy pool |

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
- whether the previously presented frame remained visible while decoding

The design is successful when repeated forward/backward boundary scrubbing:

- does not accumulate decoders as media components mount and unmount;
- never leaves an iterator open after its playback/read operation ends;
- keeps the shared `Input` and sink identity stable across range mounts;
- uses exact retrieval instead of a sequential iterator for paused random seeks;
- keeps the previous pixels visible until the requested frame is ready;
- releases all media resources at Player teardown; and
- preserves playback, looping, audio synchronization, effects, cancellation,
  and exact-frame semantics.
