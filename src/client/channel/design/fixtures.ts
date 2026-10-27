import type { GlyphName } from "../../ui/icons";

export type DesignScene = "chat" | "screens" | "focus" | "create";
export type DesignCopy = (chinese: string, english: string) => string;
export type DesignRoom = { id: string; name: string; icon: GlyphName; image?: File; private?: boolean; hidden?: boolean };

export const designPeople = [
  { id: "design-xiaoman", name: "小满", english: "Mallow", status: "sharing", owner: true },
  { id: "design-low-ground", name: "伏地魔法师", english: "Low Ground", status: "speaking" },
  { id: "design-half-crisps", name: "半包薯片", english: "Half a Crisp", status: "muted" },
  { id: "design-you", name: "你", english: "You", status: "listening" },
  { id: "design-coming", name: "马上就来", english: "One More Minute", status: "away" },
] as const;

export function designRooms(copy: DesignCopy): DesignRoom[] {
  return [
    { id: "lounge", name: copy("客厅", "Living room"), icon: "couch" },
    { id: "games", name: copy("再来一局", "One more round"), icon: "gamepad" },
    { id: "cinema", name: copy("放映室", "Movie night"), icon: "clapperboard" },
    { id: "quiet", name: copy("安静角落", "Quiet corner"), icon: "book", private: true },
  ];
}

export const designScenes: { id: DesignScene; name: [string, string]; title: [string, string]; note: [string, string] }[] = [
  { id: "chat", name: ["日常聊天", "Chat"], title: ["先坐下来，再决定一起做什么。", "Settle in. See where the evening goes."],
    note: ["房间在左，朋友在右。聊天是房间的常态，分享和语音随时开始。", "Rooms on the left, friends on the right. Chat stays home; sharing and voice are always nearby."] },
  { id: "screens", name: ["多人分享", "Screens"], title: ["各玩各的，也能待在一起。", "Different screens. Same room."],
    note: ["选择要看的画面，再进入网格。成员常驻，聊天留在舞台下方。", "Choose the screens to watch, then see them together. Members stay in place; conversation lives below."] },
  { id: "focus", name: ["专注观看", "Focus"], title: ["看清这一幕，也不错过朋友。", "A closer look, without leaving the room."],
    note: ["聚焦只调整画面的排布。其他分享、成员和聊天仍各在原位。", "Focus changes the stage, not your place. Other shares, members and conversation stay within reach."] },
  { id: "create", name: ["创建房间", "Create"], title: ["给新房间起个名字，就开始。", "A name. A little space of your own."],
    note: ["用完整对话框承接创建。先命名，再选择访问方式；私密选项按需出现。", "A complete dialog for a complete task. Name first, access second; private options appear when needed."] },
];

export function readDesignScene(): DesignScene {
  const id = location.hash.slice(1);
  return designScenes.find(scene => scene.id === id)?.id ?? "chat";
}
