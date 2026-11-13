import MarkdownIt from "markdown-it";
import { isExternalLink } from "./external-link";
import { releaseNotesBody } from "../../shared/release-headline.mjs";

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });
markdown.validateLink = isExternalLink;
markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};

export function renderReleaseNotes(body: string): string {
  return markdown.render(releaseNotesBody(body));
}
