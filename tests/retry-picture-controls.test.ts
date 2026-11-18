import {expect,test,vi} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {ChannelStage,type ChannelStageProps} from "../src/client/channel/components/ChannelStage";
import {setCopy} from "../src/client/ui/copy";

test("picture retry is immediately available for waiting remote screens",()=>{
  setCopy({lang:"en"});
  const source={kind:"screen" as const,audience:[],id:"screen",userId:"friend",name:"Friend",roomName:"Room",source:{kind:"screen" as const,name:null},title:null,owned:false,localSource:false,subscribed:true,paused:false,deliveryFailed:true};
  const props:ChannelStageProps={sources:[source],focusedId:"screen",canSubscribe:true,onFocus:vi.fn(),onWatch:vi.fn(),onUnwatch:vi.fn(),onRetryPicture:vi.fn(),onPause:vi.fn(),onStop:vi.fn(),onInputPolicy:vi.fn(),onInputDecide:vi.fn(),onInputSimultaneous:vi.fn(),onInputShortcut:vi.fn()};
  expect(renderToStaticMarkup(createElement(ChannelStage,props))).toContain('aria-label="Retry picture"');
  const stream={id:"video",getAudioTracks:()=>[]} as unknown as MediaStream;
  expect(renderToStaticMarkup(createElement(ChannelStage,{...props,sources:[{...source,stream}]}))).not.toContain('aria-label="Retry picture"');
  for(const difference of[{owned:true},{localSource:true}])expect(renderToStaticMarkup(createElement(ChannelStage,{...props,sources:[{...source,...difference}]}))).not.toContain('aria-label="Retry picture"');
  const disabled=renderToStaticMarkup(createElement(ChannelStage,{...props,canSubscribe:false}));
  expect(disabled).toMatch(/aria-label="Retry picture"[^>]*disabled/);
});
