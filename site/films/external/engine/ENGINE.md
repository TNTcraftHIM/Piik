# Film module contract

Each films/<ID>/film.js exports meta and build(stage, {lang, signal}). Metadata
owns title, dimensions, duration, CSS, subset fonts and Opus/AAC paths. Builders
return a Film with render(seconds). Frames reconstruct from the requested film
time; a scene does not own a second playback clock.

The player owns one native audio element, loading, playback and selection.
Optional `meta.holdEnd` retains the ending without a center playback cover.
At that endpoint, the player marks the visible stage with `data-ending-idle`;
film-local CSS may animate its mascot outside the completed film/audio clock,
respecting reduced motion. Leaving the viewport or page pauses that decoration.
render() can return a promise while a staged interface catches up; live playback
keeps rendering the current audio position. D/G await their three UI fixtures
before publishing the film and implement dispose() to retire them. The load's
abort signal also retires fixtures before readiness completes.

Keep film-local strings in strings.js and use module-relative URLs. Shared visual
helpers from A remain dependencies of C/F/G. Runtime fonts are the supplied
film/language subsets; changing copy requires rebuilding those subsets from the
original production sources. Keep their license notices with them.
