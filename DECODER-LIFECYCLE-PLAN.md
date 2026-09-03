# Media Retention and Decoder Lifecycle

## Goal

Keep exact-frame preview seeks warm without treating browser media resources as
unbounded. React and DOM lifetime are presentation concerns; container, byte
cache, decoded-frame, and codec lifetime must be managed independently.

This document covers the Mediabunny/WebCodecs preview path:

```text
MediaVideo -> MediaPlayer -> Mediabunny Input + CanvasSink -> VideoDecoder
           -> copied canvas -> DOM canvas
```

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

## What We Can Retain

| Resource | Retention | Reason |
| --- | --- | --- |
| Parsed metadata and duration | Player-scoped | Small, immutable, and independent of a live decoder. |
| Mediabunny `Input` and `UrlSource` | Active plus bounded idle set | Preserves container parsing, range-request state, and encoded-byte cache. Each source still consumes memory and must be evictable. |
| Encoded-byte cache | Bounded by bytes | `UrlSource.maxCacheSize` defaults to 64 MiB per source. A per-source cap alone is not a global budget. |
| Active `VideoAsset` / iterator | While leased | Required by mounted presentations and in-flight seeks; never evict active work. |
| Idle `VideoAsset` / decoder | Small bounded warm set | Avoids the cold-seek penalty for recent sources without exhausting implementation-specific codec resources. |
| Last presented copied canvas | Small bounded frame cache | Gives immediate visual continuity after decoder eviction. Budget by pixel bytes, not only entry count. |
| DOM canvas and `MediaPresentation` | Mount-scoped | Holds callbacks, effects, delay handles, and a particular DOM target. It is not reusable media state. |
| Audio scheduling and presentation | Mount-scoped | Bound to the current AudioContext timing and presentation instance. |

The useful separation is:

```text
presentation lifetime < decoder lifetime < input/cache lifetime <= Player lifetime
```

The inequalities are policy bounds, not a requirement that every resource
survive until the Player unmounts.

## What We Must Not Retain Unbounded

### Decoder pipelines

A `CanvasSink` creates an underlying decode pipeline and can pre-decode frames.
Keeping every sink or iterator reachable keeps codec work and its resources
reachable. Retaining every decoder until Player teardown converts mount churn
into decoder exhaustion.

- [Mediabunny `CanvasSink`](https://mediabunny.dev/api/CanvasSink)
- [Mediabunny `CanvasSinkOptions`](https://mediabunny.dev/api/CanvasSinkOptions)

`CanvasSinkOptions.poolSize` bounds reusable output canvases. It does not bound
the number of `CanvasSink` instances or decoder pipelines.

### Decoded frames

Decoded frames are large. One 1920x1080 RGBA frame is approximately 8.3 MB; 30
seconds of frames at 30 fps would be roughly 7.5 GB before overhead. WebCodecs
guidance requires closing frames promptly rather than waiting for garbage
collection.

Retain a copied presentation frame, not a live `VideoFrame` owned by a decoder.
Mediabunny also documents that pooled canvases are reused, so any frame kept
outside the immediate iterator operation must have stable copied pixels.

### Inputs and network caches

An `Input` is cheaper than a decoder but is not free. It owns its source, cache,
track state, and connected operations. Mediabunny documents that
`Input.dispose()` cancels reads and sink operations and closes open decoders.

- [Mediabunny `Input.dispose()`](https://mediabunny.dev/api/Input)
- [Mediabunny guide: disposing inputs](https://mediabunny.dev/guide/reading-media-files#disposing-inputs)
- [Mediabunny `UrlSourceOptions.maxCacheSize`](https://mediabunny.dev/api/UrlSourceOptions)

Inputs may remain warm longer than decoders, but a project with many distinct
sources still needs an aggregate input/cache budget and deterministic eviction.

## DOM Media Is Not A Reservation API

For native `<video>`, the browser privately owns decoder allocation and
reclamation. Keeping a node mounted can avoid application-created remounts, but
it does not reserve a decoder slot or guarantee buffered data. `preload` is only
a hint and the user agent may ignore it or suspend loading.

- [HTML Standard: media loading and `preload`](https://html.spec.whatwg.org/multipage/media.html)
- [MDN: `HTMLMediaElement.preload`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/preload)

The Mediabunny path is lower-level: Remotion owns the objects that keep
WebCodecs work reachable, so Remotion must enforce its own bounds.

## Recommended Ownership

Use the existing Player/timeline resource manager as the single registry. Do
not create a second global cache.

The registry should distinguish resource classes:

1. A mounted `MediaPlayer` leases one presentation and one active video asset.
2. Releasing a presentation disposes DOM callbacks and timing immediately.
3. Releasing a video asset moves it into the bounded idle decoder set.
4. Decoder eviction destroys its iterator and sink work but may leave the
   corresponding Input and copied frame warm.
5. Input eviction calls `Input.dispose()`, which is the final owner cleanup for
   reads, caches, sinks, and decoders connected to that Input.
6. Player teardown disposes every remaining registry entry regardless of its
   active or idle state.

Never evict an active lease or an asset with an in-flight seek. Release becomes
eligible only after initialization and the seek chain have settled.

## Eviction Policy

There is no correct universal decoder count. Use a conservative configurable
budget and validate it on target devices.

Eviction order:

1. Expired or failed idle decoders.
2. Least-recently-used idle decoders.
3. Least-recently-used copied frames when the frame-byte budget is exceeded.
4. Least-recently-used idle Inputs when the input/cache budget is exceeded.

Active resources are excluded. A failure to create or start a decoder is also
a pressure signal: evict idle decoders, then retry once rather than accumulating
more failed assets.

Time alone is insufficient. A TTL can supplement count/byte budgets, but it
cannot replace them because rapid seeking can exhaust the browser before a
timer fires.

## Diagnostics and Acceptance

Record these values per lifecycle event:

- source key and track ID
- asset ID and presentation ID
- active and idle decoder counts
- Input count and configured cache bytes
- copied-frame count and estimated pixel bytes
- lease, release, eviction, decoder-start failure, and final-disposal reason
- seek request time, first decoded-frame time, and whether a copied frame was
  presented while decoding

The design is successful when repeated forward/backward boundary scrubbing:

- reuses recently idle decoders without black frames;
- keeps decoder, Input, and copied-frame counts within their budgets;
- evicts only idle resources;
- recovers from decoder allocation failure by evicting and retrying once;
- releases all media resources at Player teardown; and
- preserves correct playback, audio synchronization, effects, and exact-frame
  presentation after eviction.
