# Public website

The website source is `site/`. It explains Piik; it does not run rooms, signaling
or media. The [public introduction plan](../design/public-introduction.md) owns
the draft's content and design boundary.

## Preview

With the repository's development dependencies installed:

```sh
npx vite site --host 127.0.0.1 --port 18887 --strictPort
```

Open `http://127.0.0.1:18887`. Publishing needs no Vite build or Node runtime:
the site is static HTML/CSS/JS/SVG. Keep asset links relative so both a custom
domain and GitHub's `/Piik/` project path work.

## Publish when approved

1. Confirm the public copy, download/demo destinations and repository visibility.
   A private-source Pages site requires an eligible GitHub plan; its published
   website is not made private simply by keeping the source repository private.
2. In repository **Settings > Pages**, choose **GitHub Actions** as the source.
   Use the dedicated Pages workflow, not publication of the repository root or
   all of `docs/`, which includes internal research and operational reference.
3. Set the approved `piik.tv` custom domain in Pages settings and configure its
   DNS using GitHub's [current domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
   Actions publishing does not need a `CNAME` file in the source tree.
4. Dispatch **Website** from `main` after the reviewed site is merged. The
   workflow uploads only `site/`; no App/Server packaging is run. Verify the
   domain, HTTPS, both languages, relative asset paths and primary links.

There is no automatic deployment on branch pushes. The workflow is prepared,
but writing it does not enable Pages or change DNS. The private production
site and any future US P2P-only demo remain separate deployments.

For rollback, dispatch the previously accepted site revision from a reviewed
revert on `main`; runtime App/Server binaries and databases are unaffected.
