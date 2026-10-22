import { participantColor } from '../../../src/client/components/living/participant-color.ts';

// Synthetic identities stay the same in the story, room, voice and reactions.
export const HOST = '48452aab-eacb-4b44-be07-29f0235513d3';
export const GUESTS = ['cb15840a-a10e-4170-ab8c-4d127c051f3b', '9d7ed079-d241-4242-ae1f-a888e3a4c621'];
export const COLOURS = [HOST, ...GUESTS].map(participantColor);
export const cast = zh => ({ name: zh ? '阿团' : 'Tuan', names: zh ? ['小圆', '阿点'] : ['Yuan', 'Dian'] });
