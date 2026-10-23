# Public film and README fixture

`/film/` plays A, **The Calling Card / 预告状**, in English or Chinese.
The homepage loads this single player only when its film entry is opened;
closing the entry unloads playback. There is no version switch. The former
1.0 film remains in Git history and is excluded from website builds.

`npm run build:website` builds the page and copies only A's required runtime,
fonts, compressed audio and license notices from [`../films/external/`](../films/external/README.md).
The output runtime directory is content-hashed together with its relative
dependencies. Open `/film/?lang=en` or `/film/?lang=zh-CN` after building.
The [selected film source](../films/external/README.md) owns provenance and
source editing; other candidate films remain in Git history. A is authored artwork; product changes do not
automatically redraw its interface scenes.

`ui/` is the independent, staged **real product component fixture** used by
README screenshots. The ordinary website build retains `/film/ui/index.html`;
the homepage and A never load it. Its `score.js` owns the deterministic fixture
clock, not the public film's timing. For example,
`/film/ui/index.html?still=viewer&lang=en&theme=light` renders the Viewer still.
The screenshot workflow builds current product components with sample data;
workflow or framing changes still need visual review. It does not connect a room.
