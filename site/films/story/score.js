// Review cuts share cast and product truth, not a layout or a scene clock.
// Hold the actual picker before confirmation so its source remains readable.
export const SOURCE_READ = { at: 2, beats: 2 };
export const STUDY =
  {
    id: 'story', label: 'A²', artwork: 'party', name: '今晚，缺个对手', subtitle: '叙事精修 / 共享屏幕，朋友参与',
    description: '先共享屏幕，让远处的朋友看到同一局游戏，再开麦聊天、邀请朋友接手。双人夺旗里一个失误，换来熟悉的损友反应。保留原故事和音乐，打磨动作、字幕与收尾。',
    bpm: 115, beats: 120, music: 'funky-chunk', trim: 16.685,
    scenes: [[0, '缺个对手'], [8, '把朋友叫来'], [16, '分享游戏'], [24, '发出邀请'],
      [36, '有话就说'], [40, '开麦说话'], [52, '换手'], [56, '房主确认'],
      [68, '两个人同一局'], [88, '再来一局'], [96, '认识 Piik']],
    stills: [1.7, 19.6, 37.4],
    voices: [[1, 0, 'Want to play?', '来一局？'], [9.3, 1, 'I am not there!', '可我不在你旁边啊。'],
      [13, 0, 'Come on in.', '发你个邀请。'], [29.5, 1, 'Send it!', '发我！'],
      [33.1, 1, 'Got it!', '看到了！'], [36.5, 0, 'Mic check!', '开麦！'],
      [42.4, 0, 'Can you hear me?', '听得到吗？'], [48.3, 1, 'Loud and clear!', '听到了，开打！'],
      [53, 1, 'My turn!', '换我来！'], [65.6, 0, 'All yours.', '交给你了。'],
      [70, 2, 'Go go go!', '快，抢旗！'], [79, 2, 'Watch out!', '哎，小心！'],
      [89, 0, 'You mean it?', '不是，你来真的？'], [91.7, 1, 'Good game.', '承让。'],
      [94, 0, 'One more!', '再来！']],
    verdict: '这次重点看：屏幕共享是否仍是主线；游戏的目标、失误和结果是否一眼看懂；字幕、音乐和画面是否跟得上。游戏是采用 CC0 像素素材创作的演示场景，不是异地网络实录。',
  };
export const durationOf = study => study.beats * 60 / study.bpm;
export const cuesOf = study => study.voices.map(([beat, actor, en, zh]) => ({
  at: beat * 60 / study.bpm, actor, en, zh,
}));
export function sceneAt(study, time) {
  const beat = time * study.bpm / 60;
  const index = study.scenes.findLastIndex(([at]) => beat >= at);
  return { index: Math.max(0, index), beat, local: beat - study.scenes[Math.max(0, index)][0] };
}
