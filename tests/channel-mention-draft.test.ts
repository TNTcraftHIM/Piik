import { describe, expect, it } from "vitest";
import { editMentions, mentionQuery } from "../src/client/channel/components/ChannelMentionSuggestions";

describe("textarea mention references", () => {
  const mention = { userId: "bo", start: 3, end: 6 };
  it("keeps UTF-16 offsets after emoji and ignores email addresses and selections", () => {
    expect(mentionQuery("😀 @小", 5)).toEqual({ start: 3, end: 5, query: "小" });
    expect(mentionQuery("a@b.com", 7)).toBeNull();
    expect(mentionQuery("@Bo", 0, 3)).toBeNull();
  });
  it("normalizes the lookup while retaining the original text range and name-length boundary", () => {
    const decomposed = "e\u0301".repeat(40);
    expect(mentionQuery(`@${decomposed}`, 81)).toEqual({ start: 0, end: 81, query: "é".repeat(40) });
    expect(mentionQuery("@" + "x".repeat(41), 42)).toBeNull();
  });
  it("shifts a selected identity when text is inserted before it", () => {
    expect(editMentions("hi @Bo!", "😀 hi @Bo!", [mention])).toEqual([{ ...mention, start: 6, end: 9 }]);
  });
  it("does not attach the old identity to an edited or partially deleted name", () => {
    expect(editMentions("hi @Bo!", "hi @Bob!", [mention])).toEqual([]);
    expect(editMentions("hi @Bo!", "hi @B!", [mention])).toEqual([]);
    expect(editMentions("hi @Bo!", "hi @Ada!", [mention])).toEqual([]);
  });
  it("retains references through punctuation and edits after the mention", () => {
    expect(editMentions("hi @Bo!", "hi @Bo!!", [mention])).toEqual([mention]);
    expect(editMentions("hi @Bo!", "hi @Bo hello", [mention])).toEqual([mention]);
  });
  it("replaces the selected reference without retargeting another identity in the draft", () => {
    const references = [{ userId: "ada", start: 0, end: 4 }, { userId: "bo", start: 9, end: 12 }];
    expect(editMentions("@Ada and @Bo", "@Coco and @Bo", references)).toEqual([{ userId: "bo", start: 10, end: 13 }]);
    expect(editMentions("@Ada and @Bo", "@Ada then @Bo", references)).toEqual([
      { userId: "ada", start: 0, end: 4 }, { userId: "bo", start: 10, end: 13 },
    ]);
  });
});
