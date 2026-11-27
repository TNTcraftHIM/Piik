import { identityHash } from "../lib/identity-hash";
import { say } from "../ui/copy";

const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** The short tag is a display cue. The member ID still owns identity. */
export function memberName(id: string, name: string | undefined, distinguish = false): string {
  if (name === undefined) return say("conversation.user");
  if (name && !distinguish) return name;
  const hash = identityHash(id);
  let tag = "";
  for (let offset = 15; offset >= 0; offset -= 5) tag += alphabet[(hash >>> offset) & 31];
  return `${name || say("channel.people.guest")} #${tag}`;
}

export function duplicateMemberNames(people: readonly { name: string }[]): Set<string> {
  const seen = new Set<string>(), duplicates = new Set<string>();
  for (const { name } of people) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return duplicates;
}
