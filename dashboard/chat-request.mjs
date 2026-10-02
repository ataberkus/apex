import {validateImages} from './attachments.mjs';

// This is the native Pi RPC prompt shape, not an OpenAI-specific chat payload.
export function promptCommand(body, session) {
  if (!['idle', 'running'].includes(session.status)) throw new Error('This session has ended. Resume it before sending a message.');
  if (typeof body.message !== 'string' || body.message.length > 100000) throw new Error('Message must be text and no longer than 100,000 characters.');
  const images = validateImages(body.images, session.input?.includes('image') === true);
  if (!body.message.trim() && !images.length) throw new Error('Write a message or attach an image.');
  return {type: 'prompt', message: body.message, ...(images.length ? {images} : {}),
    ...(session.status === 'running' ? {streamingBehavior: 'steer'} : {})};
}
