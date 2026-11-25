import {expect,test,vi} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {ChannelStage,type ChannelStageProps} from "../src/client/channel/components/ChannelStage";
import {setCopy,t} from "../src/client/ui/copy";

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

test("a picture's Watch or Retry failure stays with that picture wherever it is",()=>{
  setCopy({lang:"en"});
  const offline=t("en","channel.error.roomHostOffline");
  const source={kind:"screen" as const,audience:[],id:"screen",userId:"friend",name:"Friend",roomName:"Room",source:{kind:"screen" as const,name:null},title:null,owned:false,localSource:false,subscribed:false,paused:false,pictureFailure:"room_host_offline"};
  const props:ChannelStageProps={theaterMode:[false,vi.fn()],sources:[source],focusedId:null,canSubscribe:true,onFocus:vi.fn(),onWatch:vi.fn(),onUnwatch:vi.fn(),onRetryPicture:vi.fn(),onPause:vi.fn(),onStop:vi.fn(),onInputPolicy:vi.fn(),onInputDecide:vi.fn(),onInputSimultaneous:vi.fn(),onInputShortcut:vi.fn()};
  const offer=renderToStaticMarkup(createElement(ChannelStage,props));
  expect(offer.split('class="c3-monitor-offer"')[1]).toContain(offline);
  const waiting=renderToStaticMarkup(createElement(ChannelStage,{...props,sources:[{...source,subscribed:true}]}));
  expect(waiting.split('class="c3-monitor-wait"')[1]).toContain(offline);
  expect(waiting).toContain('aria-label="Retry picture"');
  const stream={id:"video",getAudioTracks:()=>[]} as unknown as MediaStream;
  const picture=renderToStaticMarkup(createElement(ChannelStage,{...props,sources:[{...source,subscribed:true,stream}]}));
  expect(picture.split('class="c3-mini-message"')[1]).toContain(offline);
  expect(renderToStaticMarkup(createElement(ChannelStage,{...props,sources:[{...source,pictureFailure:undefined}]}))).not.toContain("c3-picture-failure");
});
