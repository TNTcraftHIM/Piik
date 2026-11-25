import {expect,test,vi} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {ChannelStage,type ChannelStageProps} from "../src/client/channel/components/ChannelStage";
import {setCopy} from "../src/client/ui/copy";

test("picture retry is immediately available for waiting remote screens",()=>{
  setCopy({lang:"en"});
  const source={kind:"screen" as const,audience:[],id:"screen",userId:"friend",name:"Friend",roomName:"Room",source:{kind:"screen" as const,name:null},title:null,owned:false,localSource:false,subscribed:true,paused:false,deliveryFailed:true};
  const props:ChannelStageProps={theaterMode:[false,vi.fn()],sources:[source],focusedId:"screen",canSubscribe:true,onFocus:vi.fn(),onWatch:vi.fn(),onUnwatch:vi.fn(),onRetryPicture:vi.fn(),onPause:vi.fn(),onStop:vi.fn(),onInputPolicy:vi.fn(),onInputDecide:vi.fn(),onInputSimultaneous:vi.fn(),onInputShortcut:vi.fn()};
  expect(renderToStaticMarkup(createElement(ChannelStage,props))).toContain('aria-label="Retry picture"');
  const stream={id:"video",getAudioTracks:()=>[]} as unknown as MediaStream;
  expect(renderToStaticMarkup(createElement(ChannelStage,{...props,sources:[{...source,stream}]}))).not.toContain('aria-label="Retry picture"');
  for(const difference of[{owned:true},{localSource:true}])expect(renderToStaticMarkup(createElement(ChannelStage,{...props,sources:[{...source,...difference}]}))).not.toContain('aria-label="Retry picture"');
  const disabled=renderToStaticMarkup(createElement(ChannelStage,{...props,canSubscribe:false}));
  const buttons = disabled.match(/<button\b[^>]*>/g) ?? [];
  const retry = buttons.find(tag => tag.includes('aria-label="Retry picture"'));
  const help = buttons.find(tag => tag.includes('aria-label="Picture help"'));
  const disabledAttribute = /\s(?:disabled(?=[\s=>])|aria-disabled="true")/;
  expect(retry).toMatch(disabledAttribute);
  expect(help).toBeUndefined();
  for (const state of [{ deliveryFailed: false }, { paused: true }, { owned: true }, { localSource: true }, { stream }, { hidden: true }]) {
    const markup = renderToStaticMarkup(createElement(ChannelStage, { ...props, sources: [{ ...source, ...state }] }));
    expect(markup).not.toContain('aria-label="Picture help"');
  }
});
